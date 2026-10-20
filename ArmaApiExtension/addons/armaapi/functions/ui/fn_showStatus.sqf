// ArmaApi_fnc_showStatus
// Shows the API status in an Eden Editor notification (or a hint in-game).
//   [] call ArmaApi_fnc_showStatus;
//   ["restart"] call ArmaApi_fnc_showStatus;   // restarts the API first

params [["_action", "", [""]]];

if (_action == "restart") then {
    [] call ArmaApi_fnc_apiStop;
    [] call ArmaApi_fnc_apiStart;
};

if !(call ArmaApi_fnc_init) exitWith {
    private _message = format ["ArmaApi: %1", ArmaApi_var_lastError];

    if (is3DEN) then {
        [_message, 1, 5] call BIS_fnc_3DENNotification;
    } else {
        hint _message;
    };

    false
};

private _status = [] call ArmaApi_fnc_apiStatus;

private _message = format [
    "ArmaApi %1 - API %2<br/>%3",
    _status get "version",
    if (_status get "running") then {"running"} else {"stopped"},
    _status get "url"
];

if (is3DEN) then {
    [_message, if (_status get "running") then {0} else {1}, 8] call BIS_fnc_3DENNotification;
} else {
    hint parseText _message;
};

_status
