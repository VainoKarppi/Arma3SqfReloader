// ArmaApi_fnc_callAsync
// Asynchronous extension call, waits (suspending) until the extension answers.
// [_method, _arguments, _timeout] call ArmaApi_fnc_callAsync
// Returns [_success:Boolean, _data] where _data is the result array or the error string.

params [["_method", "", [""]], ["_arguments", [], [[]]], ["_timeout", 10, [0]]];

if (!canSuspend) exitWith {[false, "ArmaApi_fnc_callAsync must be called from a scheduled environment"]};
if !(call ArmaApi_fnc_init) exitWith {[false, ArmaApi_var_lastError]};

private _requestId = ceil (random 100000000);
while {_requestId in ArmaApi_var_asyncRequests} do {_requestId = _requestId + 1};

ArmaApi_var_asyncRequests set [_requestId, _method];

private _request = format ["%1|%2", _method, _requestId];
private _answer = ArmaApi_var_extension callExtension [_request, _arguments];

if (_answer isEqualTo "") exitWith {
    ArmaApi_var_asyncRequests deleteAt _requestId;
    [false, "Extension returned nothing for " + _method]
};

private _result = parseSimpleArray (_answer select 0);
_result params ["_code", ["_data", []]];

if (_code != "ASYNC_SENT") exitWith {
    ArmaApi_var_asyncRequests deleteAt _requestId;
    [false, str _data]
};

// Wait for the ASYNC_RESPONSE callback.
private _deadline = diag_tickTime + _timeout;
private _response = nil;

while {isNil "_response" && diag_tickTime < _deadline} do {
    _response = ArmaApi_var_asyncResponses get _requestId;
    uiSleep 0.01;
};

if (isNil "_response") exitWith {
    ArmaApi_var_asyncRequests deleteAt _requestId;
    [false, format ["Timed out after %1s: %2", _timeout, _method]]
};

ArmaApi_var_asyncResponses deleteAt _requestId;
ArmaApi_var_asyncRequests deleteAt _requestId;

_response params ["_data", "_returnCode"];

if (ArmaApi_var_debug) then {
    diag_log format ["[ArmaApi] callAsync %1|%2 -> %3 %4", _method, _requestId, _returnCode, _data];
};

if (_returnCode != 0) exitWith {[false, _data param [0, str _data]]};

[true, _data]
