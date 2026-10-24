# Dedicated server mod example

This directory is a workspace example for a server-side Arma mod. Open `server-mod` as a VS Code
workspace and run **SqfReloader: Play** to launch a local development Arma instance with the
`@ExampleServerMod` source mounted for live reload.

The `server.cfg` is a starting point for a dedicated server. Change `passwordAdmin` before running
any server that can be reached by other people. In VS Code use **SqfReloader: Start dedicated
server (example config)** to start the server with this config and the included mission. The
command is available when this repository is the open workspace.

Functions in the addon use the `Example` tag and can be recompiled by SqfReloader. While a
multiplayer mission is active, changes made on the server are sent to clients with
`remoteExec`. The example `CfgRemoteExec` permits the receiver only on clients; adjust the
mission/mod security policy if you customize remote-executed commands.

For a non-dedicated listen server, open a multiplayer mission's `mission.sqm` in VS Code, then
right-click it and select **Start mission as non-dedicated server**. The extension starts Arma
with `-host` and the selected mission.

The extension's REST API is local to the development machine. A remote dedicated server is not
automatically connected to the local extension process; use local Arma for source live reload,
or configure an appropriate secure forwarding/development setup before exposing any API port.
