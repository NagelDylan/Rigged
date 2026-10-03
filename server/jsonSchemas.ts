// Hand-written JSON schemas for structured output. Strict-compatible: every
// object closes with additionalProperties:false and lists all properties as
// required; nullables use anyOf with null; no numeric/length limits (the
// validator clamps instead).
import { ABILITIES, ACTIONS, HYP_STATUS, INTENTS, MODEL_FIELDS, PREDICTION_EVENTS, SIDES, TEMPLATES, type CallKind } from "../src/shared/rig";

type Schema = Record<string, unknown>;

const obj = (properties: Record<string, Schema>): Schema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const str: Schema = { type: "string" };
const num: Schema = { type: "number" };
const bool: Schema = { type: "boolean" };
const en = (values: readonly string[]): Schema => ({ type: "string", enum: [...values] });
const nullable = (s: Schema): Schema => ({ anyOf: [s, { type: "null" }] });
const arr = (items: Schema): Schema => ({ type: "array", items });

export const TACTICAL_JSON_SCHEMA = obj({
  observation: str,
  hypothesis: obj({ ref: str, status: en(HYP_STATUS), field: en(MODEL_FIELDS), claim: str, confidence: num }),
  intent: en(INTENTS),
  strategy: str,
  action: obj({
    ability: en(ACTIONS),
    side: nullable(en(SIDES)),
    intensity: num,
    telegraphMs: num,
    trigger: obj({ type: en(["now", "ball_enters", "progress"]), lane: nullable(en(SIDES)), progress: nullable(num) }),
  }),
  prediction: nullable(
    obj({
      event: en(PREDICTION_EVENTS),
      side: nullable(en(SIDES)),
      ms: nullable(num),
      result: nullable(en(["dies", "evades"])),
      windowMs: num,
      pRig: num,
      pBaseline: num,
    }),
  ),
  taunt: str,
  tauntRef: nullable(en(MODEL_FIELDS)),
  nextChamber: nullable(obj({ template: en(TEMPLATES), pressureSide: nullable(en(["L", "R"])), density: num, reason: str })),
});

export const FINAL_JSON_SCHEMA = obj({
  observation: str,
  claim: str,
  targets: arr(en(MODEL_FIELDS)),
  trapSide: en(["L", "R"]),
  exitSide: en(SIDES),
  loadout: arr(en(ABILITIES)),
  useRestingSpots: bool,
  revealLine: str,
  taunt: str,
});

export const RUN_END_JSON_SCHEMA = obj({ verdict: str, memoryNotes: arr(str), taunt: str });

export const JSON_SCHEMAS: Record<CallKind, Schema> = {
  tactical: TACTICAL_JSON_SCHEMA,
  final: FINAL_JSON_SCHEMA,
  run_end: RUN_END_JSON_SCHEMA,
};
