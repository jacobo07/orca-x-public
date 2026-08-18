; Install Git during Orca setup when the machine does not already have it.
;
; Why here rather than at first launch: Orca runs the user's git binary for every source-control
; action, worktree create and status refresh. Discovering it is missing after install means the app
; opens into a degraded state the user has to leave to fix.
;
; Every failure path is non-fatal on purpose. A missing winget, no network, or a declined elevation
; prompt must not fail the Orca install — Orca still runs without git, just with source control
; unavailable, and an installer that aborts over an optional dependency is worse than one that
; reports it. The details pane carries the outcome either way.
!macro customInstall
  DetailPrint "Checking for Git..."
  ; `where` exits non-zero when the name is not on PATH. Cheaper and more accurate than probing
  ; Program Files, which misses scoop/winget/portable installs and user-scope ones.
  nsExec::ExecToStack 'cmd /c where git'
  Pop $0
  Pop $1
  ${If} $0 == 0
    DetailPrint "Git is already installed."
  ${Else}
    DetailPrint "Git not found. Installing with winget - this can take a couple of minutes..."
    nsExec::ExecToLog 'cmd /c winget install --id Git.Git -e --source winget --silent --accept-package-agreements --accept-source-agreements'
    Pop $0
    ${If} $0 == 0
      DetailPrint "Git installed. Restart open terminals so they pick up the new PATH."
    ${Else}
      DetailPrint "Could not install Git automatically (exit $0)."
      DetailPrint "Orca will run without it; install Git from https://git-scm.com/download/win to enable source control."
    ${EndIf}
  ${EndIf}
!macroend
