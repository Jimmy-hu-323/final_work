from glasses.common.logging_util import format_payload_for_log, redact_image_in_obj


def test_redact_image():
    obj = {"type": "CSChatWordImage", "data": {"askType": 2, "image": "x" * 100}}
    redacted = redact_image_in_obj(obj)
    assert "len=100" in redacted["data"]["image"]


def test_verbose_keeps_image():
    obj = {"type": "CSChatWordImage", "data": {"askType": 2, "image": "abc"}}
    out = format_payload_for_log(obj, verbose=True)
    assert '"abc"' in out
