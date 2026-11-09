import { Composition, registerRoot } from "remotion";
import { Hero } from "./Hero.jsx";

// One shot, two layouts: a wide hero for the landing page and a vertical cut
// for social. 5 s at 30 fps; the last second holds on a gentle float.
const Root = () => (
  <>
    <Composition id="HeroWide" component={Hero} durationInFrames={150} fps={30} width={1920} height={1080} defaultProps={{ layout: "wide" }} />
    <Composition id="HeroTall" component={Hero} durationInFrames={150} fps={30} width={1080} height={1920} defaultProps={{ layout: "tall" }} />
  </>
);

registerRoot(Root);
