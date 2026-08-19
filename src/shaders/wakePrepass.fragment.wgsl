// Depth prepass for the surf wake — the same erosion the beauty pass applies.

#include<snowNoise>
#include<snowWake>

varying vQ: f32;
varying vAlong: f32;
varying vAge: f32;
varying vTime: f32;
varying vViewZ: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    if (wakeEroded(input.vAlong, input.vQ, input.vAge, input.vTime)) { discard; }
    fragmentOutputs.color = vec4f(input.vViewZ, 0.0, 0.0, 1.0);
}
