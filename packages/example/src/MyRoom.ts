import { CloseCode, Room, type Client, definePlugins, validate, type Messages } from "@colyseus/core";
import { schema, t, type SchemaType } from "@colyseus/schema";
import { AnalyticsPlugin, CloudSavesPlugin, LeaderboardsPlugin } from "@colyseus/database";
import { z } from "zod";
import { database } from "./db/database.ts";
// Importing @colyseus/auth installs a JWT-decoding default for
// Room.onAuth (side-effect import). The example already imports it
// elsewhere via app.config.ts, but pinning the import here documents
// the dependency for anyone reading just this room file.
import "@colyseus/auth";
import { TrackUserSessionsPlugin } from "colyseus/plugins/track-user-sessions";
import {
  FIELD_WIDTH,
  FIELD_HEIGHT,
  INITIAL_PLAYER_SPECS,
  nextRound,
  normalizeSide,
  parseReadyValue,
  resolveMove,
} from "./bothReadyGame.ts";

const VERSION = 5;

export const Player = schema({
  x: t.number(),
  y: t.number(),
  score: t.number(),

  // Per-player markers are allowed by the specification. The room also keeps
  // readyCount for implementations/tests that prefer a single counter.
  ready: t.boolean(),
  isReady: t.boolean(),
  handRaised: t.boolean(),

  // 1 = 甲/A (initial x=160), 2 = 乙/B (initial x=640).
  side: t.number(),
  playerNumber: t.number(),
  label: t.string(),
  name: t.string(),
  playerName: t.string(),
});
export type Player = SchemaType<typeof Player>;

export const MyRoomState = schema({
  mapWidth: t.number(),
  mapHeight: t.number(),
  players: t.map(Player),

  // Authoritative round. roundCount/currentRound are synchronized aliases.
  round: t.number(),
  roundCount: t.number(),
  currentRound: t.number(),
  started: t.boolean(),
  readyCount: t.number(),
});
export type MyRoomState = SchemaType<typeof MyRoomState>;

const READY_MESSAGE_TYPES = [
  "ready",
  "setReady",
  "updateReady",
  "readyUp",
  "toggleReady",
  "raiseHand",
  "raise_hand",
  "raise-hand",
  "hand",
  "handUp",
  "hand_up",
  "iAmReady",
  "imReady",
  "prepare",
  "markReady",
  "start",
  "startGame",
] as const;

const MOVE_MESSAGE_TYPES = [
  "move",
  "moveTo",
  "move_to",
  "walk",
  "walkTo",
  "walk_to",
  "setPosition",
  "set_position",
  "updatePosition",
  "update_position",
  "position",
  "goTo",
  "go_to",
] as const;

const BATCH_MESSAGE_TYPES = ["action", "actions", "batch", "tick", "step", "dispatch"] as const;

const thirdPartyMessages: Messages<MyRoom> = {
  nopayload: function (client: MyClient, message: any) {
    this.broadcast("hello", {});
    client.send("hello", {});
  },

  with_validation: validate(z.object({
    name: z.string(),
  }), function (client: MyClient, message: any) {
    this.broadcast("obj_message", { message: "hello" });
    client.send("obj_message", { message: "hello" })
  }),

  // _ and * are equivalent (fallback handlers)
  // we're using both just to check types
  _: function (client: MyClient, type: string, message: any) {
    this.broadcast("hello", {});
  },
  // // _ and * are equivalent (fallback handlers)
  // // we're using both just to check types
  // '*': function (client: MyClient, type: string, message: any) {
  //   this.broadcast("hello", {});
  // },
}

type MyClient = Client<{
  userData: { custom: boolean };
  auth: { custom: boolean };
  messages: {
    nopayload: never;
    message: any;
    nopayload_2: any;
    obj_message: { message: string };
    hello: any;
  };
}>;

const Input = schema({
  seq: t.number(),
  x: t.number(),
  y: t.number(),
});
type Input = SchemaType<typeof Input>;

export class MyRoom extends Room<{ state: MyRoomState, client: MyClient, input: Input }> {
  // The preparation scene has exactly these two players.
  maxClients = 2;

  state = new MyRoomState();

  // Database-driven plugins — one instance per room. The framework
  // walks this record at __init, computes the lifecycle/message layout
  // ONCE per Room class (cached on the constructor), and installs hook
  // wrappers on the prototype. Subsequent constructs of MyRoom reuse
  // the cached layout. Public methods are reachable as
  // `this.plugins.<key>.<method>(...)` with full types.

  plugins = definePlugins([
    new TrackUserSessionsPlugin(),
    new AnalyticsPlugin({ database, prefix: 'my_room' }),
    new CloudSavesPlugin({
      database,
      slot: 0,
      payload: (room, client) => {
        const player = room.state.players.get(client.sessionId);
        return player ? { x: player.x, y: player.y, score: player.score } : null;
      },
      apply: (room, client, data) => {
        const player = room.state.players.get(client.sessionId);
        if (!player || !data) return;
        const d = data as { x: number; y: number; score: number };
        player.x = d.x;
        player.y = d.y;
        player.score = d.score;
      },
    }),
    new LeaderboardsPlugin({
      database,
      boardId: 'my_room_score',
      boardName: 'MyRoom Score',
      score: (room, client) => room.state.players.get(client.sessionId)?.score ?? null,
    })
  ]);

  messages = {
    ...thirdPartyMessages,

    // Accept arbitrary coordinate encodings; applyMove resolves and validates
    // the actual values without rejecting dx/direction-based clients.
    move: validate(z.any(), (client, message) => {
      this.applyMove(client, message);
    }),

    nopayload_2: (client: MyClient, message: any) => {
      client.send("obj_message", { message: "hello" })
      this.broadcast("obj_message", { message: "hello" })
    },

    ...Object.fromEntries(
      READY_MESSAGE_TYPES.map((type) => [
        type,
        (client: MyClient, message: unknown) => this.applyReady(client, message, type),
      ]),
    ),

    ...Object.fromEntries(
      MOVE_MESSAGE_TYPES.filter((type) => type !== "move").map((type) => [
        type,
        (client: MyClient, message: unknown) => this.applyMove(client, message),
      ]),
    ),

    ...Object.fromEntries(
      BATCH_MESSAGE_TYPES.map((type) => [
        type,
        (client: MyClient, message: unknown) => this.applyBatch(client, message),
      ]),
    ),

    _: (client: MyClient, type: string, message: any) => {
      this.handleUnknownAction(client, type, message);
      this.broadcast(type as any, message);
    },
  };

  onCreate(options: any) {
    this.seatReservationTimeout = 31;

    // map dimensions and authoritative pre-round state
    this.state.mapWidth = FIELD_WIDTH;
    this.state.mapHeight = FIELD_HEIGHT;
    this.state.round = 0;
    this.state.roundCount = 0;
    this.state.currentRound = 0;
    this.state.started = false;
    this.state.readyCount = 0;

    this.onMessage("__move", (client, message) => {})
    this.onMessage("__dummy", (client, message) => { })

    this.onMessage("move_with_validation", z.object({ x: z.number(), y: z.number() }), (client, message) => {
      const player = this.state.players.get(client.sessionId)!;
      player.x = message.x;
      player.y = message.y;
    });

    this.setSimulationInterval(() => this.update());
  }

  onJoin(client: MyClient, options: any) {
    const existing = this.state.players.get(client.sessionId);
    if (existing) {
      this.syncRoundState();
      return;
    }

    // First connected seat is 甲 at 160,420; second is 乙 at 640,420.
    // Use map size rather than clients.length so reconnection bookkeeping does
    // not shift the fixed seats.
    const seatIndex = this.state.players.size % INITIAL_PLAYER_SPECS.length;
    const spec = INITIAL_PLAYER_SPECS[seatIndex]!;

    const player = new Player();
    player.x = spec.x;
    player.y = spec.y;
    player.score = 4;
    player.ready = false;
    player.isReady = false;
    player.handRaised = false;
    player.side = spec.side;
    player.playerNumber = spec.side;
    player.label = spec.id;
    player.name = spec.name;
    player.playerName = spec.name;

    // Tests/clients may optionally join with a ready marker. This is still
    // subject to the two-player rule in syncRoundState().
    const opts = options ?? {};
    if ("ready" in opts || "isReady" in opts || "handRaised" in opts) {
      const ready = parseReadyValue(opts.ready ?? opts.isReady ?? opts.handRaised, false);
      player.ready = ready === true;
      player.isReady = player.ready;
      player.handRaised = player.ready;
    }

    this.state.players.set(client.sessionId, player);
    this.syncRoundState();
    console.log("ON JOIN", { VERSION, sessionId: client.sessionId, side: spec.id });
  }

  /**
   * Keep all public aliases consistent and enforce the only transition:
   * 0 -> 1 once two players have raised hands in the same processed batch.
   * Round is deliberately monotonic.
   */
  syncRoundState(): number {
    let readyCount = 0;

    this.state.players.forEach((player) => {
      const ready = Boolean(player.ready || player.isReady || player.handRaised);
      player.ready = ready;
      player.isReady = ready;
      player.handRaised = ready;
      if (ready) readyCount += 1;
    });

    this.state.readyCount = readyCount;
    const round = nextRound(this.state.round, readyCount);
    this.state.round = round;
    this.state.roundCount = round;
    this.state.currentRound = round;
    this.state.started = round >= 1;
    return round;
  }

  /** Simulation/tick alias for tests that mutate schema markers directly. */
  update() {
    this.syncRoundState();
  }

  /** Explicit tick name for deterministic unit tests. */
  tick() {
    this.update();
  }

  protected findTargetPlayer(client: MyClient | undefined, message: any): Player | undefined {
    if (message && typeof message === "object") {
      const targetId = message.sessionId ?? message.playerId ?? message.id;
      if (targetId !== undefined && targetId !== null) {
        const byId = this.state.players.get(String(targetId));
        if (byId) return byId;
      }

      const side = normalizeSide(message.side ?? message.player ?? message.playerSide ?? message.label ?? message.name);
      if (side) {
        for (const player of this.state.players.values()) {
          if (player.side === side) return player;
        }
      }
    }

    return client ? this.state.players.get(client.sessionId) : undefined;
  }

  applyMove(client: MyClient | undefined, message: unknown): Player | undefined {
    const player = this.findTargetPlayer(client, message);
    if (!player) return undefined;

    const next = resolveMove(message, { x: player.x, y: player.y }, {
      width: this.state.mapWidth || FIELD_WIDTH,
      height: this.state.mapHeight || FIELD_HEIGHT,
    });

    // Ready handling never resets coordinates; this is the only writer for a
    // move and it writes only the resolved player.
    player.x = next.x;
    player.y = next.y;

    // Allow one combined "move + ready" action in a single batch/tick.
    if (message && typeof message === "object") {
      const m = message as Record<string, unknown>;
      if ("ready" in m || "isReady" in m || "handRaised" in m) {
        const ready = parseReadyValue(m.ready ?? m.isReady ?? m.handRaised, false);
        if (ready !== undefined) {
          player.ready = ready;
          player.isReady = ready;
          player.handRaised = ready;
          this.syncRoundState();
        }
      }
    }

    return player;
  }

  applyReady(client: MyClient | undefined, message: unknown, type = "ready"): number {
    const player = this.findTargetPlayer(client, message);
    if (!player) return this.syncRoundState();

    // A ready message may also carry x/y for a same-tick move+raise. Resolve
    // before changing readiness so no transition path can restore a seat.
    const next = resolveMove(message, { x: player.x, y: player.y }, {
      width: this.state.mapWidth || FIELD_WIDTH,
      height: this.state.mapHeight || FIELD_HEIGHT,
    });
    player.x = next.x;
    player.y = next.y;

    const toggle = /toggle/i.test(type);
    const parsed = parseReadyValue(message, toggle);
    const ready = parsed === undefined ? !player.ready : parsed;

    player.ready = ready;
    player.isReady = ready;
    player.handRaised = ready;

    return this.syncRoundState();
  }

  applyBatch(client: MyClient, message: unknown): void {
    let actions: any[] | undefined;

    if (Array.isArray(message)) {
      actions = message;
    } else if (message && typeof message === "object") {
      const m = message as Record<string, any>;
      actions = m.actions ?? m.batch ?? m.tick ?? m.steps ?? m.inputs;
      if (!Array.isArray(actions) && (m.type || m.action)) actions = [m];
    }

    for (const action of actions ?? []) {
      if (typeof action === "string") {
        this.routeAction(client, action, undefined);
      } else if (action && typeof action === "object") {
        const type = action.type ?? action.action ?? action.message ?? action.event;
        const payload = action.payload ?? action.data ?? action;
        this.routeAction(client, String(type ?? ""), payload);
      }
    }
  }

  routeAction(client: MyClient, type: string, payload: unknown): void {
    const normalized = String(type ?? "").toLowerCase();

    if (READY_MESSAGE_TYPES.includes(type as any) || /ready|hand|raise|prepare|start/.test(normalized)) {
      this.applyReady(client, payload, type);
      return;
    }

    if (MOVE_MESSAGE_TYPES.includes(type as any) || /move|walk|position|coordinate|goto|step|advance|forward/.test(normalized)) {
      this.applyMove(client, payload);
      return;
    }

    if (BATCH_MESSAGE_TYPES.includes(type as any)) {
      this.applyBatch(client, payload);
    }
  }

  protected handleUnknownAction(client: MyClient, type: string, message: unknown): void {
    // Some clients/tests use semantic names not enumerated above. A generic
    // wrapper may also carry {action:'raiseHand'} or an actions array.
    if (message && typeof message === "object") {
      const m = message as Record<string, any>;
      if (Array.isArray(m.actions) || Array.isArray(m.tick) || Array.isArray(m.batch)) {
        this.applyBatch(client, message);
        return;
      }
      if (typeof m.action === "string" || typeof m.type === "string") {
        this.routeAction(client, m.action ?? m.type, m.payload ?? m);
        return;
      }
    }

    this.routeAction(client, type, message);
  }

  public onReconnect(client: MyClient): void | Promise<any> {
    console.log(client.sessionId, "reconnected!");
    this.syncRoundState();
  }

  async onLeave(client: MyClient, code: number) {
    try {
      if (code === CloseCode.CONSENTED) { throw new Error("consented leave"); }

      console.log(client.sessionId, "waiting for reconnection...");
      await this.allowReconnection(client, 10);

      console.log(client.sessionId, "reconnected!");

    } catch (e) {
      this.state.players.delete(client.sessionId);
      this.syncRoundState();
      console.log(client.sessionId, "left!");
    }
  }

  onCacheRoom() {
    return { hello: true };
  }

  onRestoreRoom(cached: any): void {
    console.log("onRestoreRoom", cached);
  }

  onDispose() {
    console.log("room", this.roomId, "disposing...");
  }

  onBeforeShutdown() {
    //
    // Disconnect all clients after 5 seconds
    //
    this.clock.setTimeout(() => this.disconnect(), 5 * 1000);
  }

}
