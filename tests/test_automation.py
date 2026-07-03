# tests/test_automation.py
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import automation as A


def test_synth_label_prefers_real_name():
    assert A._uia_synth_label("Save", "ButtonControl", "", "", "") == "Save"


def test_synth_label_uses_labeledby_then_prevtext_then_id_then_type():
    assert A._uia_synth_label("", "EditControl", "Email", "", "") == "Email"
    assert A._uia_synth_label("", "EditControl", "", "Search the web", "") == "Search the web"
    assert A._uia_synth_label("", "EditControl", "", "", "SearchBox") == "SearchBox"
    lbl = A._uia_synth_label("", "EditControl", "", "", "")
    assert "Edit" in lbl and lbl.strip() != ""


def test_interactive_types_include_edit_and_button():
    assert "EditControl" in A.INTERACTIVE_TYPES
    assert "ButtonControl" in A.INTERACTIVE_TYPES
    assert "TextControl" not in A.INTERACTIVE_TYPES  # static text is context, not interactive


def test_element_dict_shape():
    d = A._uia_element_dict(3, "Save", "ButtonControl", (10, 20, 110, 60), True, False, False)
    assert d["id"] == 3
    assert d["name"] == "Save"
    assert d["type"] == "ButtonControl"
    assert d["rect"] == [10, 20, 110, 60]
    assert d["center"] == [60, 40]
    assert d["enabled"] is True and d["focused"] is False


def test_rank_interactive_before_static_and_named_before_synth():
    btn = A._uia_element_dict(0, "OK", "ButtonControl", (0, 0, 10, 10), True, False, False)
    txt = A._uia_element_dict(1, "Some label", "TextControl", (0, 0, 10, 10), True, False, False)
    synth = A._uia_element_dict(2, "Edit control", "EditControl", (0, 0, 10, 10), True, False, True)
    ordered = sorted([txt, synth, btn], key=A._uia_rank_key)
    assert ordered[0]["type"] == "ButtonControl"      # interactive+named first
    assert ordered[-1]["type"] == "TextControl"       # static text last


if __name__ == "__main__":
    import types
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and isinstance(fn, types.FunctionType):
            fn(); print("ok:", name)
    print("test_automation: all assertions passed")
