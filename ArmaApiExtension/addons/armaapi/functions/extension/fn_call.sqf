// ArmaApi_fnc_call
// Synchronous extension call.
// [_method, _arguments] call ArmaApi_fnc_call
// Returns the data array from ["SUCCESS", [data]] or nil on error (see ArmaApi_var_lastError).

params [["_method", "", [""]], ["_arguments", [], [[]]]];

if !(call ArmaApi_fnc_init) exitWith {nil};

private _answer = ArmaApi_var_extension callExtension [_method, _arguments];
if (_answer isEqualTo "") exitWith {
    ArmaApi_var_lastError = "Extension returned nothing for " + _method;
    diag_log format ["[ArmaApi] ERROR: %1", ArmaApi_var_lastError];
    nil
};

private _result = parseSimpleArray (_answer select 0);
_result params ["_code", ["_data", []]];

if (ArmaApi_var_debug) then {
    diag_log format ["[ArmaApi] call %1 -> %2 %3", _method, _code, _data];
};

if (_code != "SUCCESS") exitWith {
    ArmaApi_var_lastError = str _data;
    diag_log format ["[ArmaApi] ERROR %1: %2", _method, _data];
    nil
};

_data
