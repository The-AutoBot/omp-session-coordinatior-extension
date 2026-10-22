import { createMachineHandshakeHeaders } from "../shared/machine-auth";

import {
	automaticCollabDiagnosticSchema,
	type AgentMessage,
	type AutomaticCollabDiagnostic,
	type ClientFrame,
	type NotificationKind,
	type NotificationReadState,
	type NotificationRecord,
	type ServerFrame,
	type SessionDescriptor,
	type TerminalNotificationContext,
	serverFrameSchema,
	terminalNotificationFrameSchema,
  voiceHostCommandSchema,
  type VoiceHostCommand,
  type VoiceHostEvent,
} from "../shared/protocol";
import { type InputReceiptRequest, type InputReceiptResult, inputReceiptResultSchema } from "../shared/collab-input-receipts";

const MAX_INBOX_MESSAGES = 100;
const MAX_PROCESSED_MESSAGE_IDS = 512;
const MAX_PENDING_REQUESTS = 64;
const MESSAGE_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 10_000;
const RECONNECT_MAX_EXPONENT = 6;

export type SessionBusConnectionState = "stopped" | "connecting" | "registered" | "disconnected";

const SAFE_BUS_ERROR_CODES: Readonly<Record<string, true>> = {
	"connection-create-failed": true, "socket-error": true, "socket-not-open": true, "connection-closed": true,
	"registration-send-failed": true, "non-text-server-frame": true, "invalid-server-json": true, "invalid-server-frame": true,
	"invalid-voice-command": true, "request-timeout": true, "request-send-failed": true, "room-update-failed": true,
	"room-update-send-failed": true, "ack-send-failed": true, "collab-status-send-failed": true, "inbound-handling-failed": true,
	"input-state-send-failed": true, "presence-send-failed": true, "rename-send-failed": true, shutdown: true,
	"not-registered": true, "too-many-pending-requests": true, invalid_room: true, invalid_frame: true,
	registration_timeout: true, internal_error: true, authentication_failed: true, coordinator_required: true,
	sender_mismatch: true, participant_cannot_send_steer: true, message_expired: true, message_ttl_too_long: true,
	duplicate_message: true, pending_limit_reached: true, notification_rate_limited: true, notification_not_found: true,
	participant_not_authorized: true, unknown_recipient: true,
};

/** Broker code strings are untrusted; only exact known codes may enter diagnostics. */
export function safeSessionBusErrorCode(code: string | undefined): string | undefined {
	return code === undefined ? undefined : Object.hasOwn(SAFE_BUS_ERROR_CODES, code) ? code : "unclassified-code";
}

export type SessionBusDiagnostic = Readonly<{
	level: "debug" | "info" | "warn";
	event: "session_bus_closed" | "session_bus_reconnect_scheduled" | "room_publication_queued" |
		"room_publication_acknowledged" | "room_publication_rejected" | "room_publication_cleared" |
		"room_publication_stale_generation";
	fields: Readonly<Record<string, boolean | number | string>>;
}>;

export interface ManagedTimers<TTimer> {
	setTimeout(callback: () => void, delayMs: number): TTimer;
	clearTimer(timer: TTimer): void;
}

export interface SessionBusClientOptions<TTimer> {
	url: string;
	machineKey: string;
	session: Omit<SessionDescriptor, "connectedAt">;
	allowSteer: boolean;
	interactiveRoot?: boolean;
	timers: ManagedTimers<TTimer>;
	onInboundMessage(message: AgentMessage): void | Promise<void>;
  onVoiceCommand?(command: VoiceHostCommand): void;
  onVoiceDisconnect?(): void;
  onInputReceipt?(request: InputReceiptRequest): Promise<InputReceiptResult>;
  inputReceiptAvailable?(): boolean;
  onRoomInputReceiptAvailable?(room: SessionRoom): Promise<boolean>;
	onStatusChange?(status: SessionBusStatus): void;
	onDiagnostic?(diagnostic: SessionBusDiagnostic): void;
}

export interface SessionBusStatus {
	state: SessionBusConnectionState;
	role: SessionDescriptor["role"];
	activeCoordinator: boolean;
	allowSteer: boolean;
	inboxSize: number;
	reconnectAttempt: number;
	rejectedSteerCount: number;
	lastErrorCode?: string;
}

export interface OutboundMessage {
	to: string;
	text: string;
	delivery: AgentMessage["delivery"];
	triggerTurn: boolean;
}

export class SessionBusError extends Error {
	public readonly code: string;

	public constructor(code: string) {
		super(`Session bus ${code}.`);
		this.name = "SessionBusError";
		this.code = code;
	}
}

/** A broker rejection of the exact serialized terminal payload, not a retryable transport failure. */
class InvalidTerminalNotificationError extends SessionBusError {
	public constructor() {
		super("invalid_frame");
	}
}

type CorrelatedServerFrame = Extract<
	ServerFrame,
	{
		type:
			| "sessions"
			| "accepted"
			| "room_updated"
			| "notification_accepted"
			| "notifications"
			| "notification_read"
			| "notification_session_read";
	}
>;

type PendingRequest<TTimer> = {
	expectedType: CorrelatedServerFrame["type"];
	expectedNotificationId: string | undefined;
	invalidTerminalNotification: boolean;
	resolve(frame: CorrelatedServerFrame): void;
	reject(error: SessionBusError): void;
	timeout: TTimer;
};

export interface SessionRoom {
	readonly webLink: string;
	readonly expiresAt: string;
  readonly inputReceiptAvailable?: boolean;
}

type QueuedRoomPublication<TTimer> = {
	readonly room: SessionRoom | null;
	readonly revision: number;
	readonly resolve: () => void;
	readonly reject: (error: SessionBusError) => void;
	readonly timeout: TTimer;
};

type PendingTerminalNotification = {
  readonly context: TerminalNotificationContext | undefined;
  readonly kind: NotificationKind;
  sending: boolean;
};

type HeaderCapableWebSocketConstructor = typeof WebSocket & {
	new (url: string, options: { headers: Readonly<Record<string, string>> }): WebSocket;
};

/** A session-scoped client for the central credential-free WSS /bus endpoint and loopback WS development. */
export class SessionBusClient<TTimer> {
	private readonly allowSteer: boolean;
	private readonly interactiveRoot: boolean;
	private lastRoomPublicationFailure: string | undefined;
	private readonly onInboundMessage: (message: AgentMessage) => void | Promise<void>;
	private readonly session: Omit<SessionDescriptor, "connectedAt">;
  private readonly onVoiceCommand: ((command: VoiceHostCommand) => void) | undefined;
  private readonly onVoiceDisconnect: (() => void) | undefined;
  private readonly onInputReceipt: SessionBusClientOptions<TTimer>["onInputReceipt"];
  private readonly inputReceiptAvailable: SessionBusClientOptions<TTimer>["inputReceiptAvailable"];
  private inputReceiptsInFlight = 0;
  private readonly onRoomInputReceiptAvailable: SessionBusClientOptions<TTimer>["onRoomInputReceiptAvailable"];
	private readonly timers: ManagedTimers<TTimer>;
	private readonly machineKey: string;
	private readonly url: string;

	private activeCoordinator = false;
	private inbox: AgentMessage[] = [];
	private lastErrorCode: string | undefined;
	private pending = new Map<string, PendingRequest<TTimer>>();
	private processedMessageIds = new Set<string>();
	private processedMessageOrder: string[] = [];
	private reconnectAttempt = 0;
	private reconnectTimer: TTimer | undefined;
	private registered = false;
	private rejectedSteerCount = 0;
	private socket: WebSocket | undefined;
	private needsInput = false;
	private automaticCollabDiagnostic: AutomaticCollabDiagnostic | undefined;
	private terminalNotifications = new Map<string, PendingTerminalNotification>();
	private room: SessionRoom | null = null;
	private acknowledgedRoom: SessionRoom | null = null;
	private roomRevision = 0;
	private readonly queuedRoomPublications = new Set<QueuedRoomPublication<TTimer>>();
	private roomPublicationInFlight = false;
	private state: SessionBusConnectionState = "stopped";
	private stopped = true;
	private cancellationGeneration = 0;
	private readonly onStatusChange: ((status: SessionBusStatus) => void) | undefined;
	private readonly onDiagnostic: SessionBusClientOptions<TTimer>["onDiagnostic"];
	private bindingGeneration = 0;
	private handlingMessageIds = new Set<string>();

	public constructor(options: SessionBusClientOptions<TTimer>) {
		this.allowSteer = options.allowSteer;
		this.interactiveRoot = options.interactiveRoot === true;
		this.onInboundMessage = options.onInboundMessage;
    this.onVoiceCommand = options.onVoiceCommand;
    this.onVoiceDisconnect = options.onVoiceDisconnect;
    this.onInputReceipt = options.onInputReceipt;
    this.inputReceiptAvailable = options.inputReceiptAvailable;
    this.onRoomInputReceiptAvailable = options.onRoomInputReceiptAvailable;
		this.onStatusChange = options.onStatusChange;
		this.onDiagnostic = options.onDiagnostic;
		this.session = options.session;
		this.timers = options.timers;
		this.machineKey = options.machineKey;
		this.url = options.url;
	}

	public start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.connect();
	}

	public shutdown(): void {
		this.cancellationGeneration += 1;
		this.terminalNotifications.clear();
		if (this.stopped) {
			this.room = null;
			this.acknowledgedRoom = null;
			this.roomRevision += 1;
			this.rejectQueuedRoomPublications("shutdown");
			return;
		}
		this.stopped = true;
		this.setNeedsInput(false);
    this.onVoiceDisconnect?.();
		void this.setRoom(null).catch(() => undefined);
		this.acknowledgedRoom = null;
		this.registered = false;
		this.activeCoordinator = false;
		this.state = "stopped";
		this.clearReconnectTimer();
		this.notifyStatusChange();
		this.rejectAllPending("shutdown");
		this.rejectQueuedRoomPublications("shutdown");

		const socket = this.socket;
		this.socket = undefined;
		if (socket !== undefined && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
			try {
				socket.close(1000, "session shutdown");
			} catch {
				// The socket is already terminal.
			}
		}
	}

	public getStatus(): SessionBusStatus {
		return {
			state: this.state,
			role: this.session.role,
			activeCoordinator: this.activeCoordinator,
			allowSteer: this.allowSteer,
			inboxSize: this.inbox.length,
			reconnectAttempt: this.reconnectAttempt,
			rejectedSteerCount: this.rejectedSteerCount,
			...(this.lastErrorCode === undefined ? {} : { lastErrorCode: this.lastErrorCode }),
		};
	}

	private notifyStatusChange(): void {
		this.onStatusChange?.(this.getStatus());
	}

	private diagnose(diagnostic: SessionBusDiagnostic): void {
		if (this.onDiagnostic === undefined) return;
		try {
			const fields: Record<string, boolean | number | string> = {
				...diagnostic.fields, bindingGeneration: this.bindingGeneration,
			};
			for (const key of Object.keys(fields)) {
				const value = fields[key];
				if (typeof value === "number") {
					if (!Number.isSafeInteger(value) || value < 0) delete fields[key];
					else fields[key] = Math.min(value, 1_000_000_000);
				}
			}
			this.onDiagnostic?.({ ...diagnostic, fields });
		} catch {
			// Native logger failures cannot affect transport or publication ordering.
		}
	}

	public getInbox(): AgentMessage[] {
		return this.inbox.map(message => ({ ...message }));
	}

	public setIdle(idle: boolean): void {
		if (this.session.idle === idle) return;
		this.session.idle = idle;
		if (!this.registered) return;
		try {
			this.sendFrame({ type: "presence", idle });
		} catch {
			this.lastErrorCode = "presence-send-failed";
			this.closeCurrentSocket();
		}
	}

	public setName(name: string): void {
		this.session.name = name;
		if (!this.registered) return;
		try {
			this.sendFrame({ type: "rename", name });
		} catch {
			this.lastErrorCode = "rename-send-failed";
			this.closeCurrentSocket();
		}
	}

	public setRoom(room: SessionRoom | null): Promise<void> {
		if (this.queuedRoomPublications.size >= MAX_PENDING_REQUESTS) {
			return Promise.reject(new SessionBusError("too-many-pending-requests"));
		}

		// The broker's clock is authoritative for lease acceptance, including replay.
		const publicationRoom = room === null ? null : { ...room };
		const roomRevision = this.roomRevision + 1;
		this.roomRevision = roomRevision;
		this.room = publicationRoom;
		const publication = this.queueRoomPublication(publicationRoom, roomRevision);
		this.flushQueuedRoomPublications();
		return publication;
	}

	public setNeedsInput(needsInput: boolean): void {
		if (this.needsInput === needsInput) return;
		this.needsInput = needsInput;
		this.publishInputState();
	}

	public setAutomaticCollabDiagnostic(status: AutomaticCollabDiagnostic): void {
		const previousDiagnostic = this.automaticCollabDiagnostic;
		if (
			previousDiagnostic !== undefined &&
			previousDiagnostic.enabled === status.enabled &&
			previousDiagnostic.hostState === status.hostState &&
			previousDiagnostic.publicationState === status.publicationState &&
			previousDiagnostic.recoveryState === status.recoveryState &&
			previousDiagnostic.errorCode === status.errorCode &&
			previousDiagnostic.errorKind === status.errorKind &&
			previousDiagnostic.errorStage === status.errorStage
		) return;
		const parsed = automaticCollabDiagnosticSchema.safeParse(status);
		if (!parsed.success) return;
		this.automaticCollabDiagnostic = parsed.data;
		this.publishAutomaticCollabDiagnostic();
	}

	public async listSessions(): Promise<SessionDescriptor[]> {
		const requestId = crypto.randomUUID();
		const response = await this.request(requestId, { type: "list", requestId }, "sessions");
		return response.sessions.map(session => ({ ...session }));
	}

	public async sendMessage(input: OutboundMessage): Promise<{ messageId: string }> {
		if (!this.activeCoordinator && input.delivery === "steer") {
			throw new SessionBusError("participant-cannot-send-steer");
		}

		const now = new Date();
		const messageId = crypto.randomUUID();
		const requestId = crypto.randomUUID();
		const message: AgentMessage = {
			messageId,
			from: this.session.sessionId,
			to: input.to,
			text: input.text,
			delivery: input.delivery,
			triggerTurn: input.triggerTurn,
			createdAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + MESSAGE_TTL_MS).toISOString(),
		};
		const response = await this.request(requestId, { type: "send", requestId, message }, "accepted");
		return { messageId: response.messageId };
	}

	/**
	 * Queues a terminal event until the broker acknowledges it. The caller owns the
	 * UUID, so retries after a connection loss preserve broker-level idempotency.
	 */
  public sendTerminalNotification(
    notificationId: string,
    kind: NotificationKind,
    context: TerminalNotificationContext | undefined = undefined,
  ): void {
    const normalizedNotificationId = notificationId.toLowerCase();
    if (this.terminalNotifications.has(normalizedNotificationId)) return;
    this.terminalNotifications.set(normalizedNotificationId, {
      context: context === undefined ? undefined : { ...context },
      kind,
      sending: false,
    });
    this.flushTerminalNotifications();
  }

	public async listNotifications(readState: NotificationReadState, limit: number): Promise<NotificationRecord[]> {
		this.requireActiveCoordinator();
		const requestId = crypto.randomUUID();
		const response = await this.request(
			requestId,
			{ type: "notification_inbox", requestId, readState, limit },
			"notifications",
		);
		return response.notifications.map(notification => ({ ...notification }));
	}

	public async markNotificationRead(notificationId: string): Promise<void> {
		this.requireActiveCoordinator();
		const requestId = crypto.randomUUID();
		await this.request(
			requestId,
			{ type: "notification_read", requestId, notificationId: notificationId.toLowerCase() },
			"notification_read",
		);
	}

	/** Private human-view path: never queued or replayed after losing this binding. */
	public async markOwnSessionNotificationsRead(): Promise<number> {
		const socket = this.socket;
		const bindingGeneration = this.bindingGeneration;
		const sessionId = this.session.sessionId;
		const instanceId = this.session.instanceId;
		if (!this.interactiveRoot || !this.registered || this.stopped ||
			socket === undefined || socket.readyState !== WebSocket.OPEN) {
			throw new SessionBusError("not-registered");
		}
		const requestId = crypto.randomUUID();
		const response = await this.request(requestId, {
			type: "notification_session_read", requestId,
			expectedSessionId: sessionId, expectedInstanceId: instanceId,
		}, "notification_session_read");
		if (this.socket !== socket || this.bindingGeneration !== bindingGeneration ||
			this.stopped || !this.registered || response.sessionId !== sessionId) {
			throw new SessionBusError("connection-closed");
		}
		return response.updatedCount;
	}

	private connect(): void {
		if (this.stopped) return;
		const currentSocket = this.socket;
		if (currentSocket !== undefined && (currentSocket.readyState === WebSocket.CONNECTING || currentSocket.readyState === WebSocket.OPEN)) return;

		this.clearReconnectTimer();
		this.registered = false;
		this.activeCoordinator = false;
		this.state = "connecting";
		this.notifyStatusChange();

		let socket: WebSocket;
		try {
			const socketConstructor = globalThis.WebSocket as HeaderCapableWebSocketConstructor;
			socket = new socketConstructor(this.url, {
				headers: createMachineHandshakeHeaders(this.session.pcId, this.machineKey),
			});
		} catch {
			this.lastErrorCode = "connection-create-failed";
			this.rejectQueuedRoomPublications("connection-create-failed");
			this.state = "disconnected";
			this.scheduleReconnect();
			this.notifyStatusChange();
			return;
		}

		this.socket = socket;
		this.bindingGeneration += 1;
		socket.onopen = () => {
			if (this.socket !== socket || this.stopped) return;
			try {
				this.sendFrame({
					type: "register",
					session: { ...this.session, connectedAt: new Date().toISOString() },
          inputReceiptAvailable: !!this.onInputReceipt && this.inputReceiptAvailable?.() === true,
					interactiveRoot: this.interactiveRoot,
				});
			} catch {
				this.lastErrorCode = "registration-send-failed";
				this.closeCurrentSocket();
			}
		};
		socket.onmessage = event => {
			if (this.socket !== socket || this.stopped) return;
			this.handleRawServerFrame(event.data);
		};
		socket.onerror = () => {
			if (this.socket === socket && !this.stopped) {
				this.lastErrorCode = "socket-error";
				this.closeCurrentSocket();
			}
		};
		socket.onclose = event => {
			if (this.socket !== socket) return;
			this.diagnose({ level: "info", event: "session_bus_closed", fields: {
				closeCode: event.code, wasClean: event.wasClean,
				...(this.lastErrorCode === undefined ? {} : { errorCode: safeSessionBusErrorCode(this.lastErrorCode)! }),
			} });
			this.socket = undefined;
			this.registered = false;
			this.activeCoordinator = false;
      this.onVoiceDisconnect?.();
			this.rejectAllPending("connection-closed");
			this.rejectQueuedRoomPublications("connection-closed");
			if (!this.stopped) {
				this.state = "disconnected";
				this.scheduleReconnect();
			}
			this.notifyStatusChange();
		};
	}

	private handleRawServerFrame(data: unknown): void {
		if (typeof data !== "string") {
			this.lastErrorCode = "non-text-server-frame";
			this.closeCurrentSocket();
			return;
		}
		let rawFrame: unknown;
		try {
			rawFrame = JSON.parse(data);
		} catch {
			this.lastErrorCode = "invalid-server-json";
			this.closeCurrentSocket();
			return;
		}
    if (typeof rawFrame === "object" && rawFrame !== null && "type" in rawFrame &&
        typeof rawFrame.type === "string" && rawFrame.type.startsWith("voice_")) {
      const command = voiceHostCommandSchema.safeParse(rawFrame);
      if (!command.success || !this.registered || !this.onVoiceCommand) {
        this.lastErrorCode = "invalid-voice-command";
        this.closeCurrentSocket();
        return;
      }
      this.onVoiceCommand(command.data);
      return;
    }
    if (typeof rawFrame === "object" && rawFrame !== null && "type" in rawFrame &&
        rawFrame.type === "input_receipt_request") {
      const parsed = serverFrameSchema.safeParse(rawFrame);
      if (!this.registered || !parsed.success || parsed.data.type !== "input_receipt_request") {
        this.lastErrorCode = "invalid-server-frame";
        this.closeCurrentSocket();
        return;
      }
      const socket = this.socket;
      const generation = this.bindingGeneration;
      const requestId = parsed.data.requestId;
      if (!this.onInputReceipt || this.inputReceiptsInFlight >= MAX_PENDING_REQUESTS) {
        socket?.send(JSON.stringify({ type: "input_receipt_result", requestId, result: { version: 1, status: "unavailable" } }));
        return;
      }
      this.inputReceiptsInFlight += 1;
      const receipt = parsed.data.receipt;
      void Promise.resolve().then(() => this.onInputReceipt!(receipt))
        .catch(() => ({ version: 1 as const, status: "unavailable" as const })).then(result => {
        if (socket !== this.socket || generation !== this.bindingGeneration || !this.registered ||
            socket?.readyState !== WebSocket.OPEN) return;
        const checked = inputReceiptResultSchema.safeParse(result);
        socket.send(JSON.stringify({ type: "input_receipt_result", requestId,
          result: checked.success ? checked.data : { version: 1, status: "unavailable" } }));
      }).catch(() => { /* A receipt response failure must never fabricate an acknowledgement. */ })
        .finally(() => { this.inputReceiptsInFlight -= 1; });
      return;
    }
		const parsed = serverFrameSchema.safeParse(rawFrame);
		if (!parsed.success) {
			this.lastErrorCode = "invalid-server-frame";
			this.closeCurrentSocket();
			return;
		}
		this.handleServerFrame(parsed.data);
	}

	private handleServerFrame(frame: ServerFrame): void {
		switch (frame.type) {
			case "registered": {
				this.registered = true;
				this.activeCoordinator = frame.coordinator;
				this.reconnectAttempt = 0;
				this.lastErrorCode = undefined;
				this.state = "registered";
				this.notifyStatusChange();
				this.publishActiveRegistrationState();
				return;
			}
			case "sessions":
			case "accepted":
			case "room_updated":
			case "notification_accepted":
			case "notifications":
			case "notification_read":
			case "notification_session_read":
				this.resolvePending(frame);
				return;
			case "message":
				void this.handleInboundMessage(frame.message);
				return;
			case "error":
				this.lastErrorCode = frame.code;
				if (frame.code === "invalid_frame") {
					// The broker cannot correlate a malformed frame. Reject only requests
					// whose exact outgoing terminal payload is independently proven invalid.
					for (const [requestId, pending] of this.pending) {
						if (pending.invalidTerminalNotification &&
							(frame.requestId === undefined || frame.requestId === requestId)) {
							this.rejectPending(requestId, frame.code);
						}
					}
				}
				if (frame.requestId !== undefined) {
					this.rejectPending(frame.requestId, frame.code);
					return;
				}
				this.closeCurrentSocket();
				return;
		}
	}

	private async handleInboundMessage(message: AgentMessage): Promise<void> {
		if (this.processedMessageIds.has(message.messageId)) {
			this.acknowledge(message.messageId);
			return;
		}
		if (this.handlingMessageIds.has(message.messageId)) return;
		this.handlingMessageIds.add(message.messageId);
		try {
			if (this.isExpired(message)) {
				this.rememberProcessedMessage(message.messageId);
				this.acknowledge(message.messageId);
				return;
			}
			if (message.delivery === "steer" && !this.allowSteer) {
				this.rejectedSteerCount += 1;
				this.rememberProcessedMessage(message.messageId);
				this.acknowledge(message.messageId);
				return;
			}

			await this.onInboundMessage(message);
			this.addToInbox(message);
			this.rememberProcessedMessage(message.messageId);
			this.acknowledge(message.messageId);
		} catch {
			this.lastErrorCode = "inbound-handling-failed";
			// Leave the broker copy unacknowledged and reconnect for redelivery.
			this.closeCurrentSocket();
		} finally {
			this.handlingMessageIds.delete(message.messageId);
		}
	}


	private isExpired(message: AgentMessage): boolean {
		const expiresAt = Date.parse(message.expiresAt);
		return Number.isNaN(expiresAt) || expiresAt <= Date.now();
	}


	private addToInbox(message: AgentMessage): void {
		this.inbox.push(message);
		if (this.inbox.length > MAX_INBOX_MESSAGES) this.inbox.shift();
	}

	private rememberProcessedMessage(messageId: string): void {
		this.processedMessageIds.add(messageId);
		this.processedMessageOrder.push(messageId);
		if (this.processedMessageOrder.length > MAX_PROCESSED_MESSAGE_IDS) {
			const oldestMessageId = this.processedMessageOrder.shift();
			if (oldestMessageId !== undefined) this.processedMessageIds.delete(oldestMessageId);
		}
	}

	private acknowledge(messageId: string): void {
		if (!this.registered) return;
		try {
			this.sendFrame({ type: "ack", messageId });
		} catch {
			this.lastErrorCode = "ack-send-failed";
			this.closeCurrentSocket();
		}
	}

	private async publishRoom(room: SessionRoom | null, roomRevision: number): Promise<void> {
		const requestId = crypto.randomUUID();
		const socket = this.socket;
		try {
      const inputReceiptAvailable = room !== null && (this.onRoomInputReceiptAvailable
        ? await this.onRoomInputReceiptAvailable(room).catch(() => false)
        : room.inputReceiptAvailable === true);
      if (socket !== this.socket || !this.registered) throw new SessionBusError("not-registered");
			await this.request(
				requestId,
        { type: "room_update", requestId,
          room: room === null ? null : { webLink: room.webLink, expiresAt: room.expiresAt }, inputReceiptAvailable },
				"room_updated",
			);
			if (this.socket === socket) {
				const changed = this.acknowledgedRoom?.webLink !== room?.webLink || this.lastRoomPublicationFailure !== undefined;
				this.lastRoomPublicationFailure = undefined;
				this.acknowledgedRoom = room === null ? null : { ...room };
				this.diagnose({ level: changed ? "info" : "debug",
					event: room === null ? "room_publication_cleared" : "room_publication_acknowledged",
					fields: { revision: roomRevision, queueSize: this.queuedRoomPublications.size } });
			} else {
				this.diagnose({ level: "debug", event: "room_publication_stale_generation", fields: { revision: roomRevision } });
			}
		} catch (error) {
			const errorCode = error instanceof SessionBusError ? safeSessionBusErrorCode(error.code)! : "unclassified-code";
			this.diagnose({ level: this.lastRoomPublicationFailure === errorCode ? "debug" : "warn",
				event: "room_publication_rejected", fields: { revision: roomRevision, errorCode } });
			this.lastRoomPublicationFailure = errorCode;
			if (error instanceof SessionBusError) {
				if (error.code === "invalid_room" && this.roomRevision === roomRevision) {
					this.room = this.acknowledgedRoom === null ? null : { ...this.acknowledgedRoom };
					this.roomRevision += 1;
				}
				if (error.code === "request-send-failed") {
					this.lastErrorCode = "room-update-send-failed";
					this.closeCurrentSocket();
				}
				if (error.code === "request-timeout") {
					this.closeCurrentSocket();
				}
			}
			throw error;
		}
	}

	private replayRoom(): void {
		const room = this.room;
		if (room === null) {
			return;
		}
		void this.queueRoomPublication(room, this.roomRevision).catch((error: unknown) => {
			this.lastErrorCode = error instanceof SessionBusError ? error.code : "room-update-failed";
		});
		this.flushQueuedRoomPublications();
	}

	private queueRoomPublication(room: SessionRoom | null, revision: number): Promise<void> {
		const deferred = Promise.withResolvers<void>();
		let queued!: QueuedRoomPublication<TTimer>;
		const timeout = this.timers.setTimeout(() => {
			if (!this.queuedRoomPublications.has(queued)) return;
			this.queuedRoomPublications.delete(queued);
			this.diagnose({ level: "debug", event: "room_publication_rejected",
				fields: { revision, errorCode: "request-timeout", queueSize: this.queuedRoomPublications.size } });
			deferred.reject(new SessionBusError("request-timeout"));
			// A latest desired update must not silently vanish behind a slow ACK.
			// Releasing this connection clears its broker-owned room; reconnect then
			// replays the desired room (or keeps it clear), without extending its lease.
			if (this.roomRevision === revision && this.registered) this.closeCurrentSocket();
		}, REQUEST_TIMEOUT_MS);
		queued = {
			room,
			revision,
			resolve: () => deferred.resolve(undefined),
			reject: (error) => deferred.reject(error),
			timeout,
		};
		this.queuedRoomPublications.add(queued);
		this.diagnose({ level: "debug", event: "room_publication_queued",
			fields: { revision, clear: room === null, queueSize: this.queuedRoomPublications.size } });
		return deferred.promise;
	}
	private flushQueuedRoomPublications(): void {
		if (!this.registered || this.roomPublicationInFlight) return;
		const queued = this.queuedRoomPublications.values().next().value;
		if (queued === undefined) return;
		this.queuedRoomPublications.delete(queued);
		this.timers.clearTimer(queued.timeout);
		this.roomPublicationInFlight = true;
		void this.publishRoom(queued.room, queued.revision).then(queued.resolve, queued.reject).finally(() => {
			this.roomPublicationInFlight = false;
			this.flushQueuedRoomPublications();
		});
	}


	private publishInputState(): void {
		if (!this.registered) return;
		try {
			this.sendFrame({ type: "input_state", needsInput: this.needsInput });
		} catch {
			this.lastErrorCode = "input-state-send-failed";
			this.closeCurrentSocket();
		}
	}

	private publishAutomaticCollabDiagnostic(): void {
		if (!this.registered || this.automaticCollabDiagnostic === undefined) return;
		try {
			this.sendFrame({ type: "collab_status", status: this.automaticCollabDiagnostic });
		} catch {
			this.lastErrorCode = "collab-status-send-failed";
			this.closeCurrentSocket();
		}
	}

	private flushTerminalNotifications(): void {
		if (!this.registered) return;
		for (const [notificationId, notification] of this.terminalNotifications) {
			if (notification.sending) continue;
			notification.sending = true;
			void this.publishTerminalNotification(notificationId, notification);
		}
	}

	private async publishTerminalNotification(
		notificationId: string,
		notification: PendingTerminalNotification,
	): Promise<void> {
		const generation = this.cancellationGeneration;
		const requestId = crypto.randomUUID();
		const frame: Extract<ClientFrame, { type: "terminal_notification" }> = {
			type: "terminal_notification",
			requestId,
			notificationId,
			kind: notification.kind,
			...(notification.context === undefined ? {} : { context: notification.context }),
		};
		try {
			await this.request(
				requestId,
				frame,
				"notification_accepted",
			);
			if (generation === this.cancellationGeneration && this.terminalNotifications.get(notificationId) === notification) {
				this.terminalNotifications.delete(notificationId);
			}
		} catch (error) {
			if (generation !== this.cancellationGeneration || this.terminalNotifications.get(notificationId) !== notification) return;
			if (error instanceof InvalidTerminalNotificationError) {
				// An authoritative rejection cannot be recovered by replaying this payload.
				// Keep valid durable cards queued; the error remains observable in status.
				this.terminalNotifications.delete(notificationId);
				return;
			}
			notification.sending = false;
			if (!this.stopped) this.closeCurrentSocket();
		}
	}

	private publishActiveRegistrationState(): void {
		if (!this.registered) return;
		this.publishAutomaticCollabDiagnostic();
		const hasQueuedRoomPublications = this.queuedRoomPublications.size > 0;
		this.flushQueuedRoomPublications();
		if (!hasQueuedRoomPublications) {
			this.replayRoom();
		}
		this.publishInputState();
		this.flushTerminalNotifications();
	}

	private requireActiveCoordinator(): void {
		if (!this.activeCoordinator) throw new SessionBusError("active-coordinator-required");
	}

	private request<TType extends CorrelatedServerFrame["type"]>(
		requestId: string,
		frame: ClientFrame,
		expectedType: TType,
	): Promise<Extract<CorrelatedServerFrame, { type: TType }>> {
		if (!this.registered) throw new SessionBusError("not-registered");
		if (this.pending.size >= MAX_PENDING_REQUESTS) throw new SessionBusError("too-many-pending-requests");

		return new Promise((resolve, reject) => {
			const generation = this.cancellationGeneration;
			const timeout = this.timers.setTimeout(() => {
				if (generation !== this.cancellationGeneration) return;
				const pending = this.pending.get(requestId);
				if (pending === undefined) return;
				this.pending.delete(requestId);
				reject(new SessionBusError("request-timeout"));
			}, REQUEST_TIMEOUT_MS);
			const pending: PendingRequest<TTimer> = {
				expectedType,
				expectedNotificationId: frame.type === "terminal_notification" ? frame.notificationId : undefined,
				invalidTerminalNotification: false,
				resolve: response => resolve(response as Extract<CorrelatedServerFrame, { type: TType }>),
				reject,
				timeout,
			};
			this.pending.set(requestId, pending);
			try {
				const encodedFrame = JSON.stringify(frame);
				if (frame.type === "terminal_notification") {
					// Validate the exact bytes sent: JSON omits undefined object fields
					// and may otherwise differ from the caller's in-memory snapshot.
					pending.invalidTerminalNotification = !terminalNotificationFrameSchema.safeParse(JSON.parse(encodedFrame)).success;
				}
				this.sendFrame(frame, encodedFrame);
			} catch {
				this.timers.clearTimer(timeout);
				this.pending.delete(requestId);
				reject(new SessionBusError("request-send-failed"));
			}
		});
	}

	private resolvePending(frame: CorrelatedServerFrame): void {
		const pending = this.pending.get(frame.requestId);
		if (pending === undefined || pending.expectedType !== frame.type) return;
		if (frame.type === "notification_accepted" && pending.expectedNotificationId !== frame.notificationId) return;
		this.pending.delete(frame.requestId);
		this.timers.clearTimer(pending.timeout);
		pending.resolve(frame);
	}

	private rejectPending(requestId: string, code: string): void {
		const pending = this.pending.get(requestId);
		if (pending === undefined) return;
		this.pending.delete(requestId);
		this.timers.clearTimer(pending.timeout);
		pending.reject(code === "invalid_frame" && pending.invalidTerminalNotification
			? new InvalidTerminalNotificationError()
			: new SessionBusError(code));
	}

	private rejectAllPending(code: string): void {
		for (const [requestId, pending] of this.pending) {
			this.pending.delete(requestId);
			this.timers.clearTimer(pending.timeout);
			pending.reject(new SessionBusError(code));
		}
	}

	private rejectQueuedRoomPublications(code: string): void {
		if (this.queuedRoomPublications.size > 0) this.diagnose({ level: "debug", event: "room_publication_rejected",
			fields: { errorCode: safeSessionBusErrorCode(code)!, queueSize: this.queuedRoomPublications.size } });
		for (const queued of this.queuedRoomPublications) {
			this.queuedRoomPublications.delete(queued);
			this.timers.clearTimer(queued.timeout);
			queued.reject(new SessionBusError(code));
		}
	}

	private sendFrame(frame: ClientFrame, encodedFrame?: string): void {
		const socket = this.socket;
		if (socket === undefined || socket.readyState !== WebSocket.OPEN) throw new SessionBusError("socket-not-open");
		socket.send(encodedFrame ?? JSON.stringify(frame));
	}

  public sendVoiceEvent(event: VoiceHostEvent): void {
    if (!this.registered) throw new SessionBusError("not-registered");
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new SessionBusError("socket-not-open");
    socket.send(JSON.stringify(event));
  }

	private closeCurrentSocket(): void {
		const socket = this.socket;
		if (socket === undefined || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
		try {
			socket.close(1011, "session bus reconnect");
		} catch {
			// The close event will either arrive or the socket is already terminal.
		}
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectTimer !== undefined) return;
		const exponent = Math.min(this.reconnectAttempt, RECONNECT_MAX_EXPONENT);
		const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** exponent, RECONNECT_MAX_DELAY_MS);
		this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, RECONNECT_MAX_EXPONENT);
		this.diagnose({ level: "debug", event: "session_bus_reconnect_scheduled",
			fields: { reconnectAttempt: this.reconnectAttempt, retryDelayMs: delay } });
		const generation = this.cancellationGeneration;
		this.reconnectTimer = this.timers.setTimeout(() => {
			if (generation !== this.cancellationGeneration) return;
			this.reconnectTimer = undefined;
			this.connect();
		}, delay);
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer === undefined) return;
		this.timers.clearTimer(this.reconnectTimer);
		this.reconnectTimer = undefined;
	}
}
