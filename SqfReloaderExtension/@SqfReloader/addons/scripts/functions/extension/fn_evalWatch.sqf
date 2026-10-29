// Evaluates debug-console watch expressions and returns printable values for the API.
params [["_expressions", []]];

if (_expressions isEqualType "") then {
    _expressions = [_expressions];
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
