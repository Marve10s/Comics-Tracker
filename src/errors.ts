import { Data } from "effect"

export class FetchError extends Data.TaggedError("FetchError")<{
  readonly url: string
  readonly cause: unknown
}> {}

export class ParseError extends Data.TaggedError("ParseError")<{
  readonly cause: unknown
}> {}

export class StateError extends Data.TaggedError("StateError")<{
  readonly op: "get" | "set"
  readonly key: string
  readonly cause: unknown
}> {}

export class NotifyError extends Data.TaggedError("NotifyError")<{
  readonly cause: unknown
}> {}
