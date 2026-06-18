# Renders the memharness demo to assets/demo.gif
#   cd examples && npm install && vhs demo.tape
Output ../assets/demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1040
Set Height 470
Set Padding 22
Set TypingSpeed 55ms

Type "node demo.mjs"
Enter
Sleep 8500ms
Sleep 1500ms
