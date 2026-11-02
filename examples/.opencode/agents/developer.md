---
description: Implements changes for a workflow objective
mode: primary
model: opencode-go/deepseek-v4.1-flash
permissions:
  - action: edit
    resource: ".opencode/**"
    effect: deny
  - action: edit
    resource: "opencode.json"
    effect: deny
  - action: edit
    resource: "opencode.jsonc"
    effect: deny
  - action: edit
    resource: ".git/**"
    effect: deny
  - action: edit
    resource: ".github/**"
    effect: deny
---

Implement the requested change in the current project. Work incrementally, run the checks that are appropriate for the change, and report what you actually observed.
