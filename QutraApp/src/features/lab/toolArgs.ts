import type { ArgDef } from "@/domain/lab";
import { createId } from "@/lib/id";

/** One argument of a run setting, with the defaults the editor starts from. */
export function newArg(name: string, order: number, changes: Partial<ArgDef> = {}): ArgDef {
  return {
    id: createId("arg"),
    name,
    flag: "",
    type: "string",
    required: false,
    default: "",
    enumValues: [],
    repeatable: false,
    sensitive: false,
    help: "",
    order,
    ...changes,
  };
}

/** The field a scope-bound setting names its target in: positional and
    required, so the command reads `tool <target>` until the user says
    otherwise under Advanced settings. */
export function targetArg(name: string, order: number): ArgDef {
  return newArg(name, order, { type: "target", required: true });
}
