import json

from glasses.common.protocol import (
    cs_chat_word_image,
    parse_cs_chat_word_image,
    sc_chat,
    sc_error,
)


def test_cs_chat_word_image_text():
    raw = cs_chat_word_image(1, content="你好")
    msg = json.loads(raw)
    assert msg["type"] == "CSChatWordImage"
    assert msg["data"]["askType"] == 1
    assert msg["data"]["content"] == "你好"


def test_parse_cs_chat_word_image_ok():
    msg = json.loads(cs_chat_word_image(2, image="data:image/png;base64,abc"))
    parsed, err = parse_cs_chat_word_image(msg)
    assert err is None
    assert parsed is not None
    assert parsed.ask_type == 2
    assert parsed.image.startswith("data:")


def test_parse_cs_chat_word_image_bad_type():
    parsed, err = parse_cs_chat_word_image({"type": "Other", "data": {}})
    assert parsed is None
    assert "不支持" in err


def test_sc_messages():
    chat = json.loads(sc_chat(1, "hi", is_end=False))
    assert chat["data"]["isEnd"] is False
    err = json.loads(sc_error("boom"))
    assert err["data"]["message"] == "boom"
