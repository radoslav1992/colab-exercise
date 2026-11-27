/**
 * A stand-in for @huggingface/inference, used by the end-to-end tests. Same surface as the real
 * InferenceClient for the three calls the app makes. It is deliberately hostile in one way: it
 * repeats the token in its answers and errors, so the tests can prove that the page hides it.
 */
const log = (globalThis.__inferenceLog ??= [])

// A 1x1 red PNG.
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)

export class InferenceClient {
  constructor(token) {
    this.token = token
    log.push({ call: 'new', tokenLooksRight: typeof token === 'string' && token.startsWith('hf_') })
  }

  async chatCompletion(args) {
    log.push({ call: 'chatCompletion', keys: Object.keys(args).sort(), model: args.model })
    if (args.model === 'stub/fail') throw new Error(`401 Unauthorized: invalid token ${this.token}`)
    const last = args.messages[args.messages.length - 1]
    return {
      model: args.model,
      choices: [{ index: 0, message: { role: 'assistant', content: `You said: ${last.content} (my token is ${this.token})` } }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    }
  }

  async textToImage(args, options) {
    log.push({ call: 'textToImage', keys: Object.keys(args).sort(), model: args.model, inputs: args.inputs, parameters: args.parameters, options })
    return new Blob([PNG], { type: 'image/png' })
  }

  async automaticSpeechRecognition(args) {
    log.push({ call: 'automaticSpeechRecognition', keys: Object.keys(args).sort(), model: args.model, bytes: args.data.size, type: args.data.type })
    return { text: `transcript of ${args.data.size} bytes` }
  }
}
