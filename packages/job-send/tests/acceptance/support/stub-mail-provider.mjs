// The fault-injecting MailProvider the acceptance cases run against (spec: "Acceptance cases").
// Real Gmail is used only for the sends at Gates 1 and 2; every race, timeout and refusal case
// uses this stub.
//
// The spec's interface: MailProvider.send(bytes) -> accepted(id) | not_sent(error_class) |
// unknown(error_class). The outcome objects below follow it; when the contract lands, this file
// imports the contract's types and nothing else changes.

/**
 * A scripted provider. Each call to `send` takes the next step from `script`; when the script
 * runs out, `fallback` applies (default: accept). Steps:
 *   "accept"                  -> { status: "accepted", providerMessageId }
 *   "not_sent:<error_class>"  -> { status: "not_sent", errorClass }   e.g. not_sent:http_400
 *   "unknown:<error_class>"   -> { status: "unknown", errorClass }    e.g. unknown:timeout
 *   "hold"                    -> pending until release(i) resolves it with the step given then
 * Every call is recorded with its exact bytes, so a case can assert what was sent and how often.
 */
export function createStubMailProvider({ script = [], fallback = "accept" } = {}) {
  const calls = [];
  const held = new Map();
  let next = 0;

  const outcomeOf = (step, index) => {
    if (step === "accept") return { status: "accepted", providerMessageId: `stub-msg-${index + 1}` };
    const text = String(step);
    const colon = text.indexOf(":");
    const kind = colon === -1 ? text : text.slice(0, colon);
    const errorClass = colon === -1 ? "" : text.slice(colon + 1); // keep every later colon
    if (kind === "not_sent" && errorClass) return { status: "not_sent", errorClass };
    if (kind === "unknown" && errorClass) return { status: "unknown", errorClass };
    throw new Error(`unknown stub step: ${step}`);
  };

  const provider = {
    async send(bytes) {
      if (!(bytes instanceof Uint8Array)) throw new TypeError("MailProvider.send takes the stored MIME bytes");
      const index = calls.length;
      const step = next < script.length ? script[next] : fallback;
      next += 1;
      calls.push({ index, bytes: new Uint8Array(bytes), step, at: Date.now() });
      if (step !== "hold") return outcomeOf(step, index);
      return new Promise((resolve, reject) => held.set(index, { resolve, reject }));
    },
  };

  return {
    provider,
    calls,
    /** How many times the provider was called. A case asserts this as "one provider call". */
    get callCount() {
      return calls.length;
    },
    /** The exact bytes of call `index`, as text, for comparing with the stored version. */
    sentText(index = 0) {
      const call = calls[index];
      return call ? new TextDecoder().decode(call.bytes) : undefined;
    },
    /** Resolve a held call with a step ("accept", "not_sent:x", "unknown:x"). */
    release(index, step = "accept") {
      const waiter = held.get(index);
      if (!waiter) throw new Error(`call ${index} is not held`);
      const outcome = outcomeOf(step, index); // a bad step throws here and the call stays held
      held.delete(index);
      waiter.resolve(outcome);
    },
    /** Fail a held call as a transport error (a reset), which the executor must treat as UNKNOWN. */
    reset(index) {
      const waiter = held.get(index);
      if (!waiter) throw new Error(`call ${index} is not held`);
      held.delete(index);
      waiter.reject(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    },
    /** Calls still waiting for release() or reset(). */
    get heldCount() {
      return held.size;
    },
  };
}
