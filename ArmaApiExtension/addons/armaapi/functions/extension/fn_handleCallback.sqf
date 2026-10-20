// ArmaApi_fnc_handleCallback
// Entry point for every ExtensionCallback sent by the DLL.
// [_function, _dataString] call ArmaApi_fnc_handleCallback

params [["_function", "", [""]], ["_data", "", [""]]];

if (_function isEqualTo "") exitWith {};
if (_function == "BATCH") exitWith {
    [_data] call ArmaApi_fnc_handleBatch;
};

private _parsed = parseSimpleArray _data;

if (ArmaApi_var_debug) then {
    diag_log format ["[ArmaApi] callback %1: %2", _function, _data];
};

// Asynchronous method answers: "ASYNC_RESPONSE|<id>|<returnCode>"
if ((_function select [0, 14]) == "ASYNC_RESPONSE") exitWith {
    (_function splitString "|") params ["", ["_requestId", "-1"], ["_returnCode", "0"]];

    private _id = parseNumber _requestId;
    if (_id < 0) exitWith {};

    ArmaApi_var_asyncResponses set [_id, [_parsed, parseNumber _returnCode]];
};

private _method = (_function splitString "|") param [0, _function];

switch (_method) do {
    case "COMMAND": {
        _parsed params [
            ["_type", "code", [""]],
            ["_target", "", [""]],
            ["_code", "", [""]]
        ];

        if (_type == "recompile") then {
            if (_target == "") then {
                [] call ArmaApi_fnc_reloadFunctions;
            } else {
                [_target] call ArmaApi_fnc_reloadFunction;
            };
        } else {
            if (_code != "") then {call compile _code};
        };
    };

    case "SEND": {
        _parsed params [["_target", "", [""]], ["_data", [], [[]]]];
        if (_target isEqualTo "") exitWith {};

        if (!(missionNamespace getVariable [format ["ArmaApi_var_fnc_%1", _target], false])) exitWith {
            diag_log format ["[ArmaApi] SEND: function %1 is not registered with ArmaApi_fnc_send", _target];
        };

        [_data] call (missionNamespace getVariable [format ["ArmaApi_var_handler_%1", _target], {}]);
    };

    case "RELOAD": {
        [_parsed param [0, [], [[]]]] call ArmaApi_fnc_reloadFunctions;
    };

    case "EXEC": {
        private _code = _parsed param [0, "", [""]];
        if (_code != "") then {call compile _code};
    };

    case "EVENT": {
        _parsed params [["_eventName", "", [""]], ["_eventData", [], [[]]]];
        if (_eventName isEqualTo "") exitWith {};

        private _handler = missionNamespace getVariable [format ["ArmaApi_var_on_%1", _eventName], nil];
        if (!isNil "_handler") then {[_eventData] call _handler};
    };

    default {
        diag_log format ["[ArmaApi] unhandled callback %1: %2", _function, _data];
    };
};
