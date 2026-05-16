import { CoalShader } from "../components/CoalShader";

export function Favicon() {
    return (
        <div className="relative bg-ink-950 overflow-hidden w-full h-full">
            <div className="absolute inset-0">
                <CoalShader />
            </div>
        </div>
    );
}
