/*
    Author: Arma 3 SQF Reloader

    Description:
        preInit example for mission-local CfgFunctions. Runs on the server before
        the mission objects are initialized.

    Parameter(s):
        None

    Returns:
        Nothing

    Example:
        // Executed by Arma through CfgFunctions preInit; no call needed.
*/
if (!isServer) exitWith {};
diag_log "[ExampleMission] CfgFunctions preInit ran (MP server)";
missionNamespace setVariable ["ExampleMission_preInitRan", true];
