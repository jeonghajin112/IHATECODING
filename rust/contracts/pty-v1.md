# PTY broker protocol v1

This freezes the newline-delimited JSON boundary currently used between the C#
application and its Node PTY broker. A Rust sidecar introduced later must remain
compatible with this contract while both backends are available.

## Application to broker

- `{"type":"start","id":"...","file":"...","args":[],"cwd":"...","columns":120,"rows":30}`
- `{"type":"input","id":"...","data":"..."}`
- `{"type":"resize","id":"...","columns":120,"rows":30}`
- `{"type":"kill","id":"..."}`
- `{"type":"shutdown"}`

## Broker to application

- `{"type":"broker-ready"}`
- `{"type":"started","id":"...","pid":1234}`
- `{"type":"output","id":"...","data":"..."}`
- `{"type":"error","id":"...","message":"..."}`
- `{"type":"exit","id":"...","exitCode":0}`

Every message occupies one UTF-8 line. Output chunks may split Unicode scalar
values at the pipe boundary; the receiving implementation must use an
incremental UTF-8 decoder.
