// Depth for the surf wake — the same erosion the beauty pass applies, so the
// depth map holds the eroded crest rather than the solid sheet underneath it.

#include<snowNoise>
#include<snowWake>

varying vQ: f32;
varying vAlong: f32;
varying vAge: f32;
varying vTime: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    if (wakeEroded(input.vAlong, input.vQ, input.vAge, input.vTime)) { discard; }
    fragmentOutputs.color = vec4f(input.position.z, 0.0, 0.0, 1.0);
}
