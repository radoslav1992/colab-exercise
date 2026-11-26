/**
 * The one place that says where the runtime and the model libraries load from.
 *
 * Production: pinned versions on the jsDelivr CDN. Nothing is bundled, so the site itself stays a
 * few hundred kilobytes and the student's browser caches the large files.
 *
 * Tests and offline work: override with the VITE_* variables (see .env.e2e), for example to serve
 * Pyodide from the `pyodide` npm package. The overrides are read at build time only. They are never
 * taken from the page address or from a notebook, because whoever controls these addresses controls
 * the code that runs.
 */

/** Must be the same version as the `pyodide` dev dependency in package.json. */
export const PYODIDE_VERSION = '314.0.8'
export const TRANSFORMERS_VERSION = '4.3.2'
export const HF_INFERENCE_VERSION = '4.13.33'

const env = import.meta.env

export interface RuntimeConfig {
  /** Folder with pyodide.mjs, pyodide.asm.wasm, python_stdlib.zip, pyodide-lock.json and the packages. Ends with "/". */
  pyodideIndexUrl: string
  /** ES module of Transformers.js (`@huggingface/transformers`). */
  transformersUrl: string
  /** ES module of the Hugging Face inference client (`@huggingface/inference`). */
  hfInferenceUrl: string
}

export const config: RuntimeConfig = {
  pyodideIndexUrl: env.VITE_PYODIDE_INDEX_URL ?? `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
  transformersUrl:
    env.VITE_TRANSFORMERS_URL ?? `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}`,
  hfInferenceUrl:
    env.VITE_HF_INFERENCE_URL ?? `https://cdn.jsdelivr.net/npm/@huggingface/inference@${HF_INFERENCE_VERSION}/+esm`,
}
