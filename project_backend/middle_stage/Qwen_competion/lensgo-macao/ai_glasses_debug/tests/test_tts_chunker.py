from glasses.server.tts_chunker import TtsChunker


def test_chunker_sentence_end():
    c = TtsChunker(min_chars=2, max_chars=80)
    parts = c.push("你好。")
    assert parts == ["你好。"]


def test_chunker_flush_remainder():
    c = TtsChunker(min_chars=50, max_chars=80)
    assert c.push("短") == []
    assert c.flush() == ["短"]
