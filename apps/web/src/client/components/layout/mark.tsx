import { ProjectMark } from "./project-identity";
import { useProjectIdentity } from "./use-project-identity";

export function BrandMark({ alt = "", size = 24 }: { alt?: string; size?: number }) {
	const project = useProjectIdentity("nocoo/giraffe");
	return (
		<ProjectMark project={project} navigation size={size} alt={alt} fallbackSrc="/logo-32.png" />
	);
}
