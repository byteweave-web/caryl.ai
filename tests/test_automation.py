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


def test_type_prep_replaces_short_single_line_edit_values():
    # Save-dialog filename box, pre-filled "space.txt": select-all so typing REPLACES it
    # (the space.txtspace.txt bug). Applies when we clicked the field (targeted) or when
    # the focused field lives in a Win32 dialog (#32770) - the field is pre-focused there.
    assert A._type_prep("EditControl", "space.txt", True, "Notepad") == "replace"
    assert A._type_prep("EditControl", "space.txt", False, "#32770") == "replace"


def test_type_prep_appends_to_documents_never_replaces():
    # A document body must NEVER be selected-and-replaced; move the caret to the end so a
    # focus click can't leave it mid-text (the interleaved-paragraph bug).
    assert A._type_prep("DocumentControl", "some text", True, "Notepad") == "append"
    assert A._type_prep("EditControl", "x" * 300, True, "Notepad") == "append"
    assert A._type_prep("EditControl", "line1\nline2", True, "Notepad") == "append"


def test_type_prep_leaves_caret_alone_when_safe():
    # Untargeted typing outside a dialog: the caret is where the app put it - don't touch.
    assert A._type_prep("EditControl", "short doc", False, "Notepad") == "none"
    # Empty field: nothing to clear or append to.
    assert A._type_prep("EditControl", "", True, "#32770") == "none"
    assert A._type_prep("DocumentControl", "", True, "Notepad") == "none"


def test_should_paste_long_or_multiline_text():
    # Long/multi-line text pastes atomically (one ctrl+v) instead of ~6s of keystrokes that
    # stray focus changes can garble mid-way.
    assert A._should_paste("hello") is False
    assert A._should_paste("x" * 200) is True
    assert A._should_paste("two\nlines") is True


if __name__ == "__main__":
    import types
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and isinstance(fn, types.FunctionType):
            fn(); print("ok:", name)
    print("test_automation: all assertions passed")
