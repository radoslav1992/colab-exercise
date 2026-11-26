"""The sample notebooks, executed cell by cell under CPython with real NumPy.

00, 04 and 05 need nothing but NumPy and ``lab``'s output functions. 01, 02 and 03 also call models;
here those calls are answered by fake_lab_js, so what is tested is the notebooks' own Python (the
exercises, the checks, the plotting), not the models.
"""

import json
import re
import time
import unittest

import notebook_runner
from solutions import EXERCISE_CHECKS, SOLUTIONS

NAMES = [
    "00-check-your-setup.ipynb",
    "01-speech-to-text.ipynb",
    "02-text-to-speech.ipynb",
    "03-llm-tokens-and-sampling.ipynb",
    "04-attention-from-scratch.ipynb",
    "05-diffusion-toy.ipynb",
]


class NotebookFiles(unittest.TestCase):
    def test_valid_nbformat_4_5(self):
        for name in NAMES:
            with self.subTest(name):
                nb = notebook_runner.load(name)
                self.assertEqual((nb["nbformat"], nb["nbformat_minor"]), (4, 5))
                self.assertIn("kernelspec", nb["metadata"])
                ids = [cell["id"] for cell in nb["cells"]]
                self.assertEqual(len(ids), len(set(ids)), "cell ids are unique")
                for cell in nb["cells"]:
                    self.assertRegex(cell["id"], r"^[a-zA-Z0-9_-]{1,64}$")
                    self.assertIn(cell["cell_type"], ("code", "markdown"))
                    self.assertIsInstance(cell["source"], list)
                    if cell["cell_type"] == "code":
                        self.assertEqual(cell["outputs"], [], "sample notebooks are handed out without outputs")
                        self.assertIsNone(cell["execution_count"])
                        compile("".join(cell["source"]), cell["id"], "exec", flags=0x2000)  # top-level await allowed
                    else:
                        self.assertNotIn("outputs", cell)

    def test_model_ids_are_variables_in_the_first_code_cell(self):
        expected = {
            "01-speech-to-text.ipynb": ["Xenova/whisper-tiny.en"],
            "02-text-to-speech.ipynb": ["Xenova/speecht5_tts"],
            "03-llm-tokens-and-sampling.ipynb": ["Xenova/distilgpt2"],
        }
        for name, models in expected.items():
            nb = notebook_runner.load(name)
            first = "".join(next(cell for cell in nb["cells"] if cell["cell_type"] == "code")["source"])
            for model in models:
                self.assertIn(f'MODEL = "{model}"', first, name)
            # Every notebook says roughly how large its download is.
            intro = "".join(nb["cells"][0]["source"])
            self.assertRegex(intro, r"\*\*Download:\*\* (roughly|a few)", name)

    def test_every_notebook_has_a_check_cell(self):
        for name in NAMES:
            self.assertTrue(notebook_runner.check_cells(notebook_runner.load(name)), name)


class NotebooksRun(unittest.TestCase):
    def run_notebook(self, name, solved=True):
        fake = notebook_runner.install_lab()
        nb = notebook_runner.load(name)
        started = time.time()
        namespace, results = notebook_runner.run(nb, replace=SOLUTIONS.get(name) if solved else None, stop_on_error=solved)
        return nb, namespace, results, fake, time.time() - started

    def test_numpy_only_notebooks_run_as_handed_out(self):
        for name in ("00-check-your-setup.ipynb", "04-attention-from-scratch.ipynb", "05-diffusion-toy.ipynb"):
            with self.subTest(name):
                self.assertNotIn(name, SOLUTIONS, "these notebooks have no cell to complete")
                nb, namespace, results, fake, seconds = self.run_notebook(name)
                self.assertTrue(all(error is None for error in results.values()))
                methods = {method for method, _ in fake.calls}
                self.assertLessEqual(methods, {"device", "token.status"}, "no model, audio or network calls")
                print(f"\n    {name}: {len(results)} code cells in {seconds:.1f} s under CPython", end="")

    def test_00_outputs(self):
        _, namespace, _, fake, _ = self.run_notebook("00-check-your-setup.ipynb")
        kinds = [sorted(output["data"]) for output in fake.outputs]
        self.assertIn(["text/html", "text/plain"], kinds, "the table")
        png = next(output["data"]["image/png"] for output in fake.outputs if "image/png" in output["data"])
        import base64

        self.assertTrue(base64.b64decode(png).startswith(b"\x89PNG"), "lab.show made a PNG from the array")

    def test_04_attention_outputs(self):
        _, namespace, _, fake, _ = self.run_notebook("04-attention-from-scratch.ipynb")
        images = [output for output in fake.outputs if "image/png" in output["data"]]
        self.assertEqual(len(images), 3, "three attention pictures")
        self.assertEqual(namespace["mha_weights"].shape, (4, 6, 6))

    def test_05_diffusion_trains_and_draws(self):
        _, namespace, _, fake, seconds = self.run_notebook("05-diffusion-toy.ipynb")
        svgs = [output["data"]["text/html"] for output in fake.outputs if "text/html" in output["data"]]
        self.assertEqual(len(svgs), 5, "data, forward process, loss curve, reverse process, result")
        for svg in svgs:
            self.assertTrue(svg.startswith("<svg") and svg.endswith("</svg>"))
            self.assertNotIn("nan", svg.lower())
        self.assertGreater(svgs[-1].count("<circle"), 1000, "generated and real points are drawn")
        self.assertLess(namespace["generated_distance"], 0.5 * namespace["noise_distance"])
        self.assertLess(namespace["train_seconds"], 60)
        print(f"\n    05-diffusion-toy: training {namespace['train_seconds']:.1f} s, whole notebook {seconds:.1f} s under CPython", end="")

    def test_model_notebooks_run_with_the_reference_solutions(self):
        for name in ("01-speech-to-text.ipynb", "02-text-to-speech.ipynb", "03-llm-tokens-and-sampling.ipynb"):
            with self.subTest(name):
                nb, namespace, results, fake, _ = self.run_notebook(name)
                self.assertTrue(all(error is None for error in results.values()))
                self.assertTrue(any(method == "pipeline.create" for method, _ in fake.calls))

    def test_01_details(self):
        _, namespace, _, fake, _ = self.run_notebook("01-speech-to-text.ipynb")
        created = [params for method, params in fake.calls if method == "pipeline.create"]
        self.assertEqual((created[0]["task"], created[0]["model"]), ("automatic-speech-recognition", "Xenova/whisper-tiny.en"))
        loaded = [params for method, params in fake.calls if method == "audio.load"]
        self.assertEqual(loaded[0]["url"], "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav")
        self.assertEqual(namespace["word_error_rate"](namespace["REFERENCE"], namespace["result"]["text"]), 0.0)
        self.assertEqual(sum("audio" in output["data"].get("text/html", "") for output in fake.outputs), 2, "two audio players")

    def test_02_details(self):
        _, namespace, _, fake, _ = self.run_notebook("02-text-to-speech.ipynb")
        call = next(params for method, params in fake.calls if method == "pipeline.call")
        self.assertEqual(call["options"]["speaker_embeddings"], "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/speaker_embeddings.bin")
        svg = next(output["data"]["text/html"] for output in fake.outputs if output["data"].get("text/html", "").startswith("<svg"))
        self.assertEqual(svg.count("<line"), 600)

    def test_03_details(self):
        _, namespace, _, fake, _ = self.run_notebook("03-llm-tokens-and-sampling.ipynb")
        logits_calls = [params for method, params in fake.calls if method == "lm.logits"]
        self.assertEqual(len(logits_calls), 1 + 3 * 15, "one look at the logits, then three generations of 15 tokens")
        self.assertFalse(any(method.startswith("inference.") for method, _ in fake.calls), "the hosted cell is skipped without a token")

    def test_exercises_fail_until_they_are_solved(self):
        for name, checks in EXERCISE_CHECKS.items():
            with self.subTest(name):
                nb, namespace, results, _, _ = self.run_notebook(name, solved=False)
                for cell_id in SOLUTIONS[name]:
                    self.assertIsInstance(results[cell_id], type(None), "the exercise cell itself only defines a function")
                for cell_id in checks:
                    self.assertIsInstance(results[cell_id], NotImplementedError, f"{cell_id} must fail on the unsolved exercise")
                self.assertEqual(sorted(SOLUTIONS[name]), sorted(c["id"] for c in nb["cells"] if c["id"].endswith("-exercise")))

    def test_wrong_solutions_are_caught(self):
        wrong = {
            "01-speech-to-text.ipynb": {
                # Counts differing positions instead of the edit distance.
                "wer-exercise": "import re\ndef normalize(text):\n    return re.sub(r\"[^a-z0-9' ]+\", ' ', text.lower()).split()\ndef word_error_rate(reference, hypothesis):\n    ref, hyp = normalize(reference), normalize(hypothesis)\n    return sum(a != b for a, b in zip(ref, hyp)) / len(ref)\n",
            },
            "03-llm-tokens-and-sampling.ipynb": {
                # Forgets the temperature.
                "softmax-exercise": "def softmax(logits, temperature=1.0):\n    z = np.asarray(logits, dtype=np.float64)\n    e = np.exp(z - z.max())\n    return e / e.sum()\n",
            },
        }
        for name, replace in wrong.items():
            with self.subTest(name):
                notebook_runner.install_lab()
                _, results = notebook_runner.run(notebook_runner.load(name), replace=replace, stop_on_error=False)
                self.assertIsInstance(results[EXERCISE_CHECKS[name][0]], AssertionError)


if __name__ == "__main__":
    unittest.main(verbosity=2)
