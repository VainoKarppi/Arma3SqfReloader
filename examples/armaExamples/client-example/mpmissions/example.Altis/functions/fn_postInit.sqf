/*
    Author: Arma 3 SQF Reloader

    Description:
        postInit example for mission-local CfgFunctions. Runs on the server after
        the mission starts and spawns a periodic log loop.

    Parameter(s):
        None

    Returns:
        Nothing

    Example:
        // Executed by Arma through CfgFunctions postInit; no call needed.
*/
if (!isServer) exitWith {};
diag_log "[ExampleMission] CfgFunctions postInit ran (MP server)";
missionNamespace setVariable ["ExampleMission_postInitRan", true];

[] spawn {
	while {true} do {
		diag_log "preInitLoopTest";
		sleep 5;
	};
};
