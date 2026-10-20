// Unified session model shared by every adapter.
//
// Session  { agent, id, title, cwd, model, createdAt, updatedAt, file, messages }
// Message  { role: 'user', text, ts }
//        | { role: 'assistant', parts: Part[], ts }
// Part     { type: 'text', text }
//        | { type: 'tool', id, name, input, output, isError }

export function newSession(agent, id, extra = {}) {
  return {
    agent, id,
    title: '', cwd: '', model: '',
    createdAt: null, updatedAt: null, file: '',
    messages: [],
    ...extra,
  };
}

export class Builder {
  constructor(session) {
    this.session = session;
    this.tools = new Map();
  }

  get last() {
    return this.session.messages[this.session.messages.length - 1];
  }

  user(text, ts) {
    text = (text ?? '').trim();
    if (!text) return;
    this.session.messages.push({ role: 'user', text, ts });
  }

  #assistant(ts) {
    if (this.last?.role !== 'assistant') {
      this.session.messages.push({ role: 'assistant', parts: [], ts });
    }
    return this.last;
  }

  text(text, ts) {
    text = (text ?? '').trim();
    if (!text) return;
    this.#assistant(ts).parts.push({ type: 'text', text });
  }

  tool(id, name, input, ts) {
    const part = { type: 'tool', id: id ?? null, name: name || 'tool', input, output: null, isError: false };
    this.#assistant(ts).parts.push(part);
    if (id != null) this.tools.set(id, part);
    return part;
  }

  result(id, output, isError = false) {
    const part = this.tools.get(id);
    if (!part) return;
    part.output = output;
    part.isError = Boolean(isError);
  }

  done() {
    const s = this.session;
    if (!s.title) {
      const first = s.messages.find((m) => m.role === 'user');
      if (first) s.title = first.text.replace(/\s+/g, ' ').slice(0, 80);
    }
    return s;
  }
}
