"""Render reviewed unit templates; installation is an explicit operator action."""
from pathlib import Path
import argparse,re,pwd,grp
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--preview-root',type=Path,required=True)
parser.add_argument('--user',required=True);parser.add_argument('--group',required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args();root=args.preview_root.absolute()
if root!=root.resolve() or any(c.isspace() for c in str(root)):raise ValueError('Use a direct absolute preview path without whitespace.')
for value in [args.user,args.group]:
    if not re.fullmatch(r'[a-z_][a-z0-9_-]*',value):raise ValueError('Use an ordinary unprivileged service user and group.')
if pwd.getpwnam(args.user).pw_uid==0 or grp.getgrnam(args.group).gr_gid==0:raise ValueError('Choose an unprivileged service identity.')
args.output.mkdir(parents=True,exist_ok=True)
for source in Path(__file__).parent.glob('*.service.in'):
    text=source.read_text().replace('@PREVIEW_ROOT@',str(root)).replace('@SERVICE_USER@',args.user).replace('@SERVICE_GROUP@',args.group)
    (args.output/source.name.removesuffix('.in')).write_text(text)
print('Rendered unit files; inspect before installing.')
