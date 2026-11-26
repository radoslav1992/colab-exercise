"""Reference solutions for the exercise cells of the sample notebooks, by cell id.

The tests run each notebook twice: as handed out (the exercise's checks must fail) and with these
solutions (every check must pass). That proves the check cells accept a correct answer.
"""

SOLUTIONS = {
    "01-speech-to-text.ipynb": {
        "wer-exercise": '''
import re

def normalize(text):
    return re.sub(r"[^a-z0-9' ]+", " ", text.lower()).split()

def word_error_rate(reference, hypothesis):
    ref = normalize(reference)
    hyp = normalize(hypothesis)
    d = [[0] * (len(hyp) + 1) for _ in range(len(ref) + 1)]
    for i in range(len(ref) + 1):
        d[i][0] = i
    for j in range(len(hyp) + 1):
        d[0][j] = j
    for i in range(1, len(ref) + 1):
        for j in range(1, len(hyp) + 1):
            cost = 0 if ref[i - 1] == hyp[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
    return d[len(ref)][len(hyp)] / len(ref)
''',
    },
    "03-llm-tokens-and-sampling.ipynb": {
        "softmax-exercise": '''
def softmax(logits, temperature=1.0):
    z = np.asarray(logits, dtype=np.float64) / temperature
    z = z - z.max()
    e = np.exp(z)
    return e / e.sum()
''',
        "sampling-exercise": '''
def sample_next(logits, temperature=1.0, top_k=None, rng=None):
    rng = rng or np.random.default_rng()
    logits = np.asarray(logits, dtype=np.float64)
    if top_k is not None:
        keep = np.argsort(logits)[-top_k:]
        limited = np.full_like(logits, -np.inf)
        limited[keep] = logits[keep]
        logits = limited
    p = softmax(logits, temperature)
    return int(rng.choice(len(p), p=p))
''',
    },
}

# The check cells that test an exercise: they must fail on the notebook as handed out.
EXERCISE_CHECKS = {
    "01-speech-to-text.ipynb": ["wer-check"],
    "03-llm-tokens-and-sampling.ipynb": ["softmax-check", "sampling-check"],
}
