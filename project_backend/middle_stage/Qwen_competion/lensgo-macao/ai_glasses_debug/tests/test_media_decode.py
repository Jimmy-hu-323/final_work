import base64

from glasses.server.media import decode_data_url_or_b64, safe_path_segment


def test_decode_data_url():
    raw = b"\x89PNG\r\n\x1a\n"
    b64 = base64.b64encode(raw).decode()
    data_url = f"data:image/png;base64,{b64}"
    got, ext = decode_data_url_or_b64(data_url)
    assert got == raw
    assert ext == ".png"


def test_safe_path_segment():
    assert safe_path_segment("user_1") == "user_1"
    assert safe_path_segment("../x") is None
    assert safe_path_segment("a__b") is None
