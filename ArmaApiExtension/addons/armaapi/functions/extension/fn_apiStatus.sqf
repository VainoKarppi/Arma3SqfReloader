// ArmaApi_fnc_apiStatus
// Returns a HashMap describing the current API state.
// [] call ArmaApi_fnc_apiStatus

private _status = createHashMap;

_status set ["ready", ArmaApi_var_ready];
_status set ["version", ArmaApi_var_version];
_status set ["running", ArmaApi_var_apiRunning];
_status set ["url", ""];
_status set ["port", 0];

if (ArmaApi_var_ready) then {
    private _data = ["ApiUrl", []] call ArmaApi_fnc_call;
    if (!isNil "_data") then {_status set ["url", _data param [0, ""]]};

    private _port = ["ApiPort", []] call ArmaApi_fnc_call;
    if (!isNil "_port") then {_status set ["port", parseNumber (_port param [0, "0"])]};

    private _running = ["ApiIsRunning", []] call ArmaApi_fnc_call;
    if (!isNil "_running") then {_status set ["running", _running param [0, false]]};
};

_status
