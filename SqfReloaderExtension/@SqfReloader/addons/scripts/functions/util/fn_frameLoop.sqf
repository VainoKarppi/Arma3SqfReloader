// SqfReloader_fnc_frameLoop
// Optional lightweight frame loop. It is only needed when the SQF side should react
// to API messages between frames (for example to repaint editor UI after a reload).
// The loop is scheduled, so it does not cost an Unscheduled slot per frame.
//
//   [0.5, {[] call SqfReloader_fnc_showStatus}] call SqfReloader_fnc_frameLoop;
//
// params: [_interval, _code, _condition]

params [["_interval", 1, [0]], ["_code", {}, [{}]], ["_condition", {true}, [{}]]];

if (_interval < 0.05) then {_interval = 0.05};

[_interval, _code, _condition] spawn {
    params ["_interval", "_code", "_condition"];

    while {call _condition} do {
        [] call _code;
        uiSleep _interval;
    };
};

true
