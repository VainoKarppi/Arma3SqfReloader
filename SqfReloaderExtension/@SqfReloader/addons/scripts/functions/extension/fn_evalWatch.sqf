// Evaluates debug-console watch expressions and returns printable values for the API.
// The whole argument list is the expression list, so `["a","b"] call fnc` evaluates both;
// `params` would only pick up the first element here.
private _expressions = _this;

if (_expressions isEqualType "") then {
    _expressions = [_expressions];
};
// Also accept an already nested list, i.e. `[["a","b"]] call fnc`.
if ((_expressions isEqualType []) && {(count _expressions) isEqualTo 1} && {(_expressions # 0) isEqualType []}) then {
    _expressions = _expressions # 0;
};
if !(_expressions isEqualType []) exitWith {
    [[str _expressions, "<SQF error> Watch expressions must be an array or string."]]
};

private _values = [];
{
    private _expression = _x;
    private _value = "";

    if !(_expression isEqualType "") then {
        _value = "<SQF error> Watch expression must be a string.";
    } else {
        try {
            _value = str (call compile _expression);
        } catch {
            _value = format ["<SQF error> %1", _exception];
        };
    };

    _values pushBack [str _expression, _value];
} forEach _expressions;

_values
