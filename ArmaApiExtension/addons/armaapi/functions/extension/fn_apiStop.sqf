// ArmaApi_fnc_apiStop
// Stops the REST API. Returns the extension message.

if !(call ArmaApi_fnc_init) exitWith {"not initialized"};

ArmaApi_var_apiRunning = false;

private _data = ["ApiStop", []] call ArmaApi_fnc_call;

if (isNil "_data") exitWith {"stop failed"};

_data param [0, ""]
