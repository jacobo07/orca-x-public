{
  "targets": [
    {
      "target_name": "orca_taskbar_preview",
      "sources": ["src/taskbar-preview.cc"],
      "conditions": [
        [
          "OS==\"win\"",
          {
            "libraries": ["-ldwmapi.lib", "-lgdi32.lib", "-luser32.lib"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1
              }
            }
          }
        ]
      ]
    }
  ]
}
