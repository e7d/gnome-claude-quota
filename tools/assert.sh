# shellcheck shell=bash

ASSERT_PASSED=0
ASSERT_FAILED=0

assert_pass() {
    ASSERT_PASSED=$((ASSERT_PASSED + 1))
    echo "ok $1"
}

assert_reject() {
    ASSERT_FAILED=$((ASSERT_FAILED + 1))
    echo "FAIL $1: $2"
}

assert_eq() {
    if [ "$2" = "$3" ]; then
        assert_pass "$1"
    else
        assert_reject "$1" "expected '$2', got '$3'"
    fi
    return 0
}

assert_ne() {
    if [ "$2" != "$3" ]; then
        assert_pass "$1"
    else
        assert_reject "$1" "expected anything but '$2'"
    fi
    return 0
}

assert_not_empty() {
    if [ -n "$2" ]; then
        assert_pass "$1"
    else
        assert_reject "$1" "expected a value, got ''"
    fi
    return 0
}

assert_summary() {
    echo "$ASSERT_PASSED passed, $ASSERT_FAILED failed"
    [ "$ASSERT_FAILED" -eq 0 ]
}

assert_abort() {
    echo "control $1: $2" >&2
    exit 1
}

# A verdict read from output would depend on formatting; the counter is the fact.
assert_quiet() {
    local passed="$ASSERT_PASSED" failed="$ASSERT_FAILED" verdict=0
    "$1" >/dev/null
    [ "$ASSERT_FAILED" -eq "$failed" ] || verdict=1
    ASSERT_PASSED="$passed"
    ASSERT_FAILED="$failed"
    return "$verdict"
}

prove() {
    local label="$1" break_cmd="$2" restore_cmd="$3" fn="$4"
    assert_quiet "$fn" || assert_abort "$label" 'failed before the break was applied'
    eval "$break_cmd"
    assert_quiet "$fn" && { eval "$restore_cmd"; assert_abort "$label" 'still passed with the break applied'; }
    eval "$restore_cmd"
    assert_quiet "$fn" || assert_abort "$label" 'did not recover after the restore'
    echo "prove $label"
}
