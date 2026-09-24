import { ProjectMark } from "./project-identity";
import { useProjectIdentity } from "./use-project-identity";

export function BrandMark({ alt = "" }: { alt?: string }) {
	const project = useProjectIdentity("nocoo/giraffe");
	return <ProjectMark project={project} navigation alt={alt} fallbackSrc="/logo-24.png" />;
}
