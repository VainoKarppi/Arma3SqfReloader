// SqfReloader_fnc_call
// Synchronous extension call.
// [_method, _arguments] call SqfReloader_fnc_call
// Returns the data array from ["SUCCESS", [data]] or nil on error (see SqfReloader_var_lastError).

params [["_method", "", [""]], ["_arguments", [], [[]]]];

if !(call SqfReloader_fnc_init) exitWith {nil};

private _answer = SqfReloader_var_extension callExtension [_method, _arguments];
if (_answer isEqualTo "") exitWith {
    SqfReloader_var_lastError = "Extension returned nothing for " + _method;
    diag_log format ["[SqfReloader] ERROR: %1", SqfReloader_var_lastError];
    nil
};

private _payload = if (_answer isEqualType "") then {_answer} else {_answer param [0, ""]};
if (_payload isEqualTo "") exitWith {
    SqfReloader_var_lastError = "Extension returned nothing for " + _method;
    diag_log format ["[SqfReloader] ERROR: %1", SqfReloader_var_lastError];
    nil
};

private _result = parseSimpleArray _payload;
if !(_result isEqualType []) exitWith {
    SqfReloader_var_lastError = "Extension answered with an unreadable payload: " + _payload;
    diag_log format ["[SqfReloader] ERROR: %1", SqfReloader_var_lastError];
    nil
};

_result params ["_code", ["_data", []]];

if (SqfReloader_var_debug) then {
    diag_log format ["[SqfReloader] call %1 -> %2 %3", _method, _code, _data];
};

if (_code != "SUCCESS") exitWith {
    SqfReloader_var_lastError = str _data;
    diag_log format ["[SqfReloader] ERROR %1: %2", _method, _data];
    nil
};

_data
