powershell#
 Work on a feature
git checkout develop
git checkout -b feature/lobby-browser

# Make changes, commit
git add .
git commit -m "add lobby browser"

# Merge into develop first
git checkout develop
git merge feature/lobby-browser

# Test on develop, then merge to master
git checkout master
git merge develop
git push origin master