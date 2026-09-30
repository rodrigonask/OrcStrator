; OrcStrator installer (Inno Setup 6). Built by installer/release/Build-Installer.ps1,
; which defines every symbol below on the ISCC command line:
;
;   AppVersion   release version, e.g. 2.1.0
;   StageDir     folder holding launcher\ (installed as-is) and staging\
;                (the release zip plus its SIGNED payload manifest)
;   OutputDir    where OrcStrator-Setup-<AppVersion>.exe is written
;
; What this installs is deliberately NOT a runnable app. It installs the
; launcher (installer\setup.ps1, OrcStrator.exe, the icon) and stages the
; release zip and its signed manifest in {app}\staging. On first launch the
; launcher installs that zip through the same verification path as a network
; update: manifest signature against the public key embedded in setup.ps1,
; then the zip's sha256, then extract, flip current.txt, health check.
;
; Per-user, no admin, no UAC. User data (database, logs, settings) lives in
; %LOCALAPPDATA%\OrcStrator and is never removed by the uninstaller.
;
; Silent install:  OrcStrator-Setup-<v>.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR=<path>
; Scratch install (tests on a developer machine): add /ORCSCRATCH=1 to skip the
; shortcuts and the Add/Remove Programs entry, so nothing lands in the real profile.

#ifndef AppVersion
  #error AppVersion must be defined (/DAppVersion=...)
#endif
#ifndef StageDir
  #error StageDir must be defined (/DStageDir=...)
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif
; Windows file version resources only take four numbers, so a prerelease like
; 2.1.0-beta.1 is stamped as its numeric part.
#ifndef NumericVersion
  #define NumericVersion "0.0.0"
#endif

[Setup]
AppId={{6E0C7B7A-4F2B-4C55-9C43-0B7A8C1D2E31}
AppName=OrcStrator
AppVersion={#AppVersion}
AppVerName=OrcStrator {#AppVersion}
AppPublisher=OrcStrator
VersionInfoVersion={#NumericVersion}
VersionInfoProductName=OrcStrator
VersionInfoProductTextVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\OrcStrator
DefaultGroupName=OrcStrator
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
LicenseFile={#StageDir}\launcher\EULA.txt
SetupIconFile={#StageDir}\launcher\installer\icon.ico
UninstallDisplayIcon={app}\OrcStrator.exe
UninstallDisplayName=OrcStrator
OutputDir={#OutputDir}
OutputBaseFilename=OrcStrator-Setup-{#AppVersion}
; The release zip is already deflate-compressed; recompressing it buys little.
Compression=lzma2/normal
SolidCompression=no
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CreateUninstallRegKey=not IsScratchInstall
CloseApplications=yes
RestartApplications=no
; Authenticode. Build-Installer.ps1 defines CodeSign and passes the
; OrcSign tool (signtool with Azure Artifact Signing) only when the signing
; account is configured; otherwise the installer is built unsigned as before.
#ifdef CodeSign
SignTool=OrcSign
SignedUninstaller=yes
#endif

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"; Check: not IsScratchInstall

[Files]
Source: "{#StageDir}\launcher\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\staging\*"; DestDir: "{app}\staging"; Flags: ignoreversion

[InstallDelete]
; An upgrade install replaces the staged release; never leave an older zip
; next to the newer manifest.
Type: filesandordirs; Name: "{app}\staging"

[Icons]
Name: "{autoprograms}\OrcStrator"; Filename: "{app}\OrcStrator.exe"; WorkingDir: "{app}"; IconFilename: "{app}\installer\icon.ico"; AppUserModelID: "OrcStrator.Launcher"; Check: not IsScratchInstall
Name: "{autodesktop}\OrcStrator"; Filename: "{app}\OrcStrator.exe"; WorkingDir: "{app}"; IconFilename: "{app}\installer\icon.ico"; AppUserModelID: "OrcStrator.Launcher"; Tasks: desktopicon

[Run]
Filename: "{app}\OrcStrator.exe"; Description: "Launch OrcStrator"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Stop OrcStrator's own background server first, so it cannot hold
; files open and leave the uninstall half done. stop-server.ps1 stops only the
; recorded process running from <data root>\app, and never fails the uninstall.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\installer\stop-server.ps1"" -DataRoot ""{code:OrcDataRootParam}"""; Flags: runhidden waituntilterminated; RunOnceId: "StopOrcServer"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\staging"

[Code]
function IsScratchInstall: Boolean;
begin
  Result := ExpandConstant('{param:ORCSCRATCH|0}') = '1';
end;

{ The data root the launcher uses: ORCSTRATOR_DATA_DIR when set, else
  %LOCALAPPDATA%\OrcStrator. }
function OrcDataRoot: String;
begin
  Result := GetEnv('ORCSTRATOR_DATA_DIR');
  if Result = '' then
    Result := ExpandConstant('{localappdata}') + '\OrcStrator';
end;

// The same, in the shape a code constant needs ([UninstallRun]).
function OrcDataRootParam(Param: String): String;
begin
  Result := OrcDataRoot;
end;

{ Uninstall keeps the user's data: the database, logs and launcher settings in
  the data root stay. Only the extracted app code in <data root>\app goes, and
  only when current.txt proves the launcher created that folder. }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  AppDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    AppDir := OrcDataRoot + '\app';
    if FileExists(AppDir + '\current.txt') then
      DelTree(AppDir, True, True, True);
  end;
end;
