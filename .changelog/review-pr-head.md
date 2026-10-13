### Fixed

- Review only the files that the pull request changes: the diff and the commit log now start from the head commit, not from the CI merge commit, which can hold commits of another branch and made GitHub refuse the review with a 422
