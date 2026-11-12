/*
    Author: Arma 3 SQF Reloader

    Description:
        Runs when the multiplayer mission starts, before initServer.sqf and
        initPlayerLocal.sqf. Confirms that the mission scripts ran.

    Parameter(s):
        None

    Returns:
        Nothing

    Example:
        // Executed by Arma at mission start; no call needed.
*/
diag_log "[ExampleMission] init.sqf ran (MP mission)";
systemChat "ExampleMission init.sqf ran";
