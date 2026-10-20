; Per-user installer for the Switchboard tray app (Inno Setup 6.3+).
;
; Installs build\Switchboard (from scripts\make-app.ps1) into
; %LOCALAPPDATA%\Programs\Switchboard - no admin prompt - with a Start menu
; entry and an optional "start when I sign in" entry, the same HKCU Run value
; the app's own Settings toggle manages.
;
;   iscc /DAppVersion=1.2.3 installer\Switchboard.iss

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\build\Switchboard"
#endif
#ifndef OutputDir
  #define OutputDir "..\build"
#endif

[Setup]
AppId={{6E1F4C2A-8B3D-4F5E-9A7C-3D2B1E0F9C84}
AppName=Switchboard
AppVersion={#AppVersion}
AppVerName=Switchboard {#AppVersion}
AppPublisher=Switchboard
AppPublisherURL=https://shell.lfkdsk.org
AppSupportURL=https://github.com/lfkdsk/Switchboard
DefaultDirName={localappdata}\Programs\Switchboard
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=Switchboard-{#AppVersion}-x64-setup
SetupIconFile=..\Resources\Switchboard.ico
UninstallDisplayIcon={app}\Switchboard.exe
UninstallDisplayName=Switchboard
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Windows 10 1809: the first release with ConPTY, which node-pty needs.
MinVersion=10.0.17763
; The running app holds this mutex; setup asks for it to be closed first, and
; quitting the app stops the daemon (and releases runtime\node.exe) with it.
AppMutex=SwitchboardTrayApp
CloseApplications=yes

[Tasks]
Name: autostart; Description: "Start Switchboard when I sign in"

[InstallDelete]
; A fresh runtime every time: an upgrade must not inherit a stale node_modules.
Type: filesandordirs; Name: "{app}\runtime"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Switchboard"; Filename: "{app}\Switchboard.exe"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Switchboard"; ValueData: """{app}\Switchboard.exe"" --autostart"; Tasks: autostart

[Run]
Filename: "{app}\Switchboard.exe"; Description: "Launch Switchboard"; Flags: nowait postinstall skipifsilent

[Code]
// The Run value may have been written by the app's Settings rather than by
// this installer, so remove it explicitly instead of relying on uninsdeletevalue.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    RegDeleteValue(HKEY_CURRENT_USER, 'Software\Microsoft\Windows\CurrentVersion\Run', 'Switchboard');
end;
