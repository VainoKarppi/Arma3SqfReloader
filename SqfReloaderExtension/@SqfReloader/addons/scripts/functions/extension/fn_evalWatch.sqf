// Evaluates debug-console watch expressions and returns printable values for the API.
params [["_expressions", [], [[]]]];

private _values = [];
{
    private _expression = _x;
    private _value = "";

    try {
        _value = str (call compile _expression);
    } catch {
        _value = format ["<SQF error> %1", _exception];
    };

    _values pushBack [_expression, _value];
} forEach _expressions;

_values
