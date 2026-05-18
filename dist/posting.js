export async function postGeneratedComments(gitlab, project, mr, generated) {
    let posted = 0;
    for (const item of generated) {
        if (item.duplicate)
            continue;
        await gitlab.postDiscussion(project, mr, item.payload);
        posted += 1;
    }
    return posted;
}
//# sourceMappingURL=posting.js.map