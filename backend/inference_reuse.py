"""Request-local reuse of predictions for byte-for-byte identical text."""

from copy import deepcopy


class ExactPredictionCache:
    """Reuse successful calls while keeping every review's result independent.

    Create one instance per batch request. Do not normalize the text: offsets
    and model tokenization depend on the original string. Errors are not cached.
    """

    def __init__(self, predict):
        self._predict = predict
        self._results = {}

    def predict(self, text, source):
        key = (source, text)
        if key not in self._results:
            self._results[key] = deepcopy(self._predict(text, source))
        return deepcopy(self._results[key])
