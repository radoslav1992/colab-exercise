/** The sample notebooks: real `.ipynb` files in /notebooks, loaded on demand. */

export interface Sample {
  file: string
  title: string
}

export const samples: Sample[] = [
  { file: '00-check-your-setup.ipynb', title: '00 · Check your setup' },
  { file: '01-speech-to-text.ipynb', title: '01 · Speech to text' },
  { file: '02-text-to-speech.ipynb', title: '02 · Text to speech' },
  { file: '03-llm-tokens-and-sampling.ipynb', title: '03 · LLM tokens and sampling' },
  { file: '04-attention-from-scratch.ipynb', title: '04 · Attention from scratch' },
  { file: '05-diffusion-toy.ipynb', title: '05 · Diffusion on toy data' },
]

const loaders = import.meta.glob('../notebooks/*.ipynb', { query: '?raw', import: 'default' }) as Record<
  string,
  () => Promise<string>
>

export async function loadSample(file: string): Promise<string> {
  const loader = loaders[`../notebooks/${file}`]
  if (!loader) throw new Error(`Unknown sample notebook: ${file}`)
  return loader()
}
