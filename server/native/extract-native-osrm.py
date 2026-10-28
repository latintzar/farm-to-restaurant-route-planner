"""Extract only native OSRM runtime files from a pinned, flattened OCI archive."""
from pathlib import Path
import argparse,os,tarfile


def extract(source,output):
    root=Path(output).absolute()
    if root!=root.resolve():raise ValueError('Use a direct output path.')
    root.mkdir(parents=True,mode=0o700,exist_ok=True)
    if any(root.iterdir()):raise ValueError('Choose an empty output directory.')
    links=[];count=0
    with tarfile.open(source) as archive:
        for member in archive:
            name=member.name.removeprefix('./').lstrip('/')
            if '..' in Path(name).parts:raise ValueError('Archive path escapes output.')
            selected=name.startswith(('lib/','lib64/','usr/lib/','usr/local/lib/','usr/local/share/osrm/','opt/','usr/share/doc/','usr/local/bin/osrm-'))
            if not selected:continue
            target=root/name
            if member.isdir():target.mkdir(parents=True,exist_ok=True)
            elif member.isfile() or member.islnk():
                target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes(archive.extractfile(member).read())
                target.chmod(member.mode&0o755);count+=1
            elif member.issym():links.append((target,member.linkname))
    for target,value in links:
        destination=root/value.lstrip('/') if value.startswith('/') else target.parent/value
        destination=Path(os.path.normpath(destination))
        if not destination.is_relative_to(root):raise ValueError('Archive link escapes output.')
        target.parent.mkdir(parents=True,exist_ok=True)
        if not target.exists() and not target.is_symlink():target.symlink_to(os.path.relpath(destination,target.parent))
    for required in ['usr/local/bin/osrm-routed','usr/local/bin/osrm-extract','opt/car.lua','lib/x86_64-linux-gnu/ld-linux-x86-64.so.2']:
        if not (root/required).is_file():raise ValueError('Archive lacks the expected Linux amd64 runtime.')
    return count


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();print('Native runtime files:',extract(args.archive,args.output))
