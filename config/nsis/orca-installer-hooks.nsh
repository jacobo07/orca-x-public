; electron-builder accepts a single `nsis.include` file, so this is the one entry point and each
; hook keeps its own named file rather than accumulating here.
!include "${__FILEDIR__}\daemon-host-uninstall.nsh"
!include "${__FILEDIR__}\ensure-git-install.nsh"
